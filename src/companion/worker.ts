import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { discoverer } from "../discovery/index.ts";
import { crashpadHome, keyFor, loadSettings, normalizeRemote, repoIdentity } from "../discovery/store.ts";
import { git, gitOut } from "../git.ts";
import { ClaudeCodeAgent } from "../repair/claude.ts";
import { repair } from "../repair/loop.ts";
import { repairBody, repairTitle } from "../repair/pr-body.ts";
import { GitSource } from "../source.ts";
import { renderSuiteMarkdown } from "../suite/markdown.ts";
import { runSuite } from "../suite/runner.ts";
import type { SuiteReport } from "../suite/types.ts";
import { VERSION } from "../version.ts";
import { ServiceClient, ServiceError, type CompanionConfig, type LeasedJob } from "./client.ts";

const ACTIONABLE = new Set(["regression", "changed-result", "failed-assertion", "removed"]);

/** Git environment carrying the job's short-lived installation token as an HTTP header (never written to disk or argv). */
function gitEnvWithToken(token: string): NodeJS.ProcessEnv {
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

/** A per-repository clone in Crashpad's storage, fetched at exactly the job's commits. */
export async function prepareRepo(job: LeasedJob): Promise<string> {
  const key = keyFor(normalizeRemote(job.cloneUrl));
  const dir = path.join(crashpadHome(), "repos", key, "git");
  if (!(await fs.stat(path.join(dir, ".git")).catch(() => null))) {
    await fs.mkdir(dir, { recursive: true });
    await git(dir, ["init", "-q"]);
    await git(dir, ["remote", "add", "origin", job.cloneUrl]);
  }
  await git(dir, ["fetch", "--quiet", "--no-tags", "origin", job.headSha, job.baseSha], { env: gitEnvWithToken(job.token) });
  for (const sha of [job.headSha, job.baseSha]) await git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
  return dir;
}

export function annotations(r: SuiteReport): object[] {
  return r.findings
    .filter((f) => f.classification !== "pass" && f.subject.file && f.subject.line)
    .map((f) => ({
      path: f.subject.file!,
      start_line: f.subject.line!,
      end_line: f.subject.line!,
      annotation_level: ACTIONABLE.has(f.classification) ? "failure" : "warning",
      title: f.id.slice(0, 200),
      message: f.message.slice(0, 2000),
    }));
}

export interface WorkerOptions {
  client: ServiceClient;
  config: CompanionConfig;
  databaseUrl: string;
  log: (m: string) => void;
  signal?: AbortSignal;
  /** Overrides the Claude binary (tests use a mock). */
  claudeBin?: string;
  claudeEnv?: Record<string, string>;
}

/** Keep the lease alive and learn about supersession; aborts the work if the job was replaced. */
function keepAlive(o: WorkerOptions, job: LeasedJob, controller: AbortController): () => void {
  const every = Math.max(1000, Math.min(20_000, job.leaseMs / 3));
  const t = setInterval(() => {
    o.client
      .progress(job.id)
      .then((r) => {
        if (r?.cancel) {
          o.log(`job ${job.id} is ${r.status}; stopping it`);
          controller.abort();
        }
      })
      .catch(() => {});
  }, every);
  return () => clearInterval(t);
}

export async function runJob(o: WorkerOptions, job: LeasedJob): Promise<{ status: string; detail?: unknown }> {
  const controller = new AbortController();
  o.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const stop = keepAlive(o, job, controller);
  try {
    o.log(`${job.kind} ${job.repo}#${job.prNumber} @ ${job.headSha.slice(0, 12)}`);
    const dir = await prepareRepo(job);
    const baseCommit = await gitOut(dir, ["merge-base", job.baseSha, job.headSha]);
    const { key } = await repoIdentity(dir);
    const settings = (await loadSettings(key))?.config;
    if (job.kind === "check") {
      const { report } = await runSuite({
        repoRoot: dir,
        projectDir: ".",
        base: { ref: job.baseRef, commit: baseCommit, source: new GitSource(dir, baseCommit, `git ${job.baseRef}`) },
        candidate: { label: `#${job.prNumber} (${job.headRef})`, commit: job.headSha, source: new GitSource(dir, job.headSha, `git ${job.headSha.slice(0, 12)}`), code: { root: dir, commit: job.headSha } },
        databaseUrl: o.databaseUrl,
        ...(settings ? { settings } : {}),
        discover: discoverer(),
        signal: controller.signal,
        log: (m) => o.log(`  ${m}`),
      });
      if (controller.signal.aborted) return { status: "abandoned" };
      const r = await o.client.complete(job.id, { exitCode: report.exitCode, headline: report.headline, markdown: renderSuiteMarkdown(report, { maxDetails: 15 }), annotations: annotations(report) });
      return { status: "completed", detail: { exitCode: report.exitCode, ...r } };
    }

    // ---- repair
    if (!o.config.repair.enabled) {
      await o.client.complete(job.id, { exitCode: 2, headline: "Repairs are turned off on this companion", markdown: "The owner has not enabled repairs on this companion (`crashpad companion --enable-repair`). Repairs use the owner's Claude Code usage, so they never run without that opt-in. Nothing was changed." });
      return { status: "repair-disabled" };
    }
    const result = await repair({
      repoRoot: dir,
      projectDir: ".",
      base: { ref: job.baseRef, commit: baseCommit },
      candidate: { label: `#${job.prNumber} (${job.headRef})`, commit: job.headSha },
      databaseUrl: o.databaseUrl,
      ...(settings ? { settings } : {}),
      discover: discoverer(),
      agent: new ClaudeCodeAgent({ auth: o.config.repair.claudeAuth, ...(o.claudeBin ? { bin: o.claudeBin } : {}), ...(o.claudeEnv ? { env: o.claudeEnv } : {}) }),
      maxAttempts: o.config.repair.maxAttempts,
      deadlineMs: o.config.repair.deadlineMin * 60_000,
      attemptTimeoutMs: Math.min(o.config.repair.deadlineMin, 10) * 60_000,
      maxTurns: o.config.repair.maxTurns,
      ...(o.config.repair.maxBudgetUsd !== undefined ? { maxBudgetUsd: o.config.repair.maxBudgetUsd } : {}),
      signal: controller.signal,
      log: (m) => o.log(`  ${m}`),
    });
    const repairId = randomUUID();
    const attemptsMd = result.attempts.map((a) => `- attempt ${a.attempt} (${a.proposer}): ${a.verdict}: ${a.reason}`).join("\n");
    if (result.outcome !== "verified") {
      await o.client.complete(job.id, { exitCode: result.exitCode === 0 ? 2 : result.exitCode, headline: `Repair ${result.outcome}: ${result.message}`.slice(0, 250), markdown: `**${result.outcome}**: ${result.message}\n\n${attemptsMd}\n\nNothing was published.` });
      return { status: result.outcome };
    }
    let published: { prUrl: string | null; message: string; branch: string };
    try {
      published = (await o.client.fix(job.id, {
        files: result.files.map((f) => ({ path: f.path, after: f.after })),
        title: repairTitle(result, job.headRef),
        body: repairBody(result, { branch: job.headRef, repairId }),
        verification: { verified: true, exitCode: result.verification!.exitCode, headline: result.verification!.headline },
        repairId,
      }))!;
    } catch (err) {
      const msg = err instanceof ServiceError ? err.message : (err as Error).message;
      await o.client.complete(job.id, { exitCode: 2, headline: `Verified, but not published: ${msg}`.slice(0, 250), markdown: `The repair was verified, but the service did not publish it: ${msg}\n\n${attemptsMd}` }).catch(() => {});
      return { status: "not-published", detail: msg };
    }
    await o.client.complete(job.id, { exitCode: 0, headline: published.prUrl ? `Verified fix opened as a draft PR` : published.message.slice(0, 250), markdown: `${published.message}${published.prUrl ? `: ${published.prUrl}` : ""}\n\n${attemptsMd}` });
    return { status: "published", detail: published };
  } catch (err) {
    if (err instanceof ServiceError && err.status === 409) return { status: "superseded", detail: err.message };
    o.log(`job ${job.id} failed: ${(err as Error).message}`);
    await o.client.complete(job.id, { exitCode: 2, headline: "Crashpad could not run on the companion", markdown: `The companion hit an error, so nothing was verified:\n\n\`\`\`\n${String((err as Error).message).slice(0, 3000)}\n\`\`\`` }).catch(() => {});
    return { status: "error", detail: (err as Error).message };
  } finally {
    stop();
  }
}

export async function companionHeartbeat(o: WorkerOptions): Promise<void> {
  const agent = new ClaudeCodeAgent({ auth: o.config.repair.claudeAuth, ...(o.claudeBin ? { bin: o.claudeBin } : {}), ...(o.claudeEnv ? { env: o.claudeEnv } : {}) });
  const st = await agent.status().catch((e) => ({ ready: false, message: (e as Error).message }));
  await o.client.heartbeat({ version: VERSION, claude: { ready: st.ready && o.config.repair.enabled, message: o.config.repair.enabled ? st.message : `repairs off on this companion; ${st.message}` } });
}

/** Poll for work until stopped. With `once`, handle at most one job and return. */
export async function runCompanion(o: WorkerOptions & { once?: boolean; waitMs?: number }): Promise<Array<{ job: string; status: string }>> {
  const handled: Array<{ job: string; status: string }> = [];
  await companionHeartbeat(o);
  const hb = setInterval(() => void companionHeartbeat(o).catch(() => {}), 20_000);
  try {
    while (!o.signal?.aborted) {
      let job: LeasedJob | null = null;
      try {
        job = await o.client.lease(o.waitMs ?? 25_000);
      } catch (err) {
        o.log(`lease failed: ${(err as Error).message}; retrying`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (job) {
        const r = await runJob(o, job);
        handled.push({ job: job.id, status: r.status });
      }
      if (o.once) break;
    }
  } finally {
    clearInterval(hb);
  }
  return handled;
}
