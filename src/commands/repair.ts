import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { UsageError, writeReport, type Values } from "../cli.ts";
import { databaseUrl, projectDirFor } from "../context.ts";
import { discoverer, repoInputsFor } from "../discovery/index.ts";
import { git, gitOut, parseGitHubRemote, repoRoot, resolveCommit } from "../git.ts";
import { FetchGitHubApi, parseRepo, resolveToken } from "../github/client.ts";
import { publishFiles } from "../github/publish.ts";
import { ClaudeCodeAgent, type ClaudeAuthMode } from "../repair/claude.ts";
import { repair, type RepairResult } from "../repair/loop.ts";
import { REPAIR_TRAILER, repairBody, repairTitle } from "../repair/pr-body.ts";
import { renderSuiteMarkdown } from "../suite/markdown.ts";
import type { Agent } from "../repair/agent.ts";

function num(v: string | undefined, def: number, what: string): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${what} must be a positive number`);
  return n;
}

/** Loop prevention: Crashpad never repairs its own fix branches or commits. */
export async function isCrashpadFix(root: string, branch: string | undefined, commit: string): Promise<string | null> {
  if (branch && /^crashpad\/fix-/.test(branch)) return `${branch} is a Crashpad fix branch`;
  const msg = await gitOut(root, ["log", "-1", "--format=%B", commit]).catch(() => "");
  if (new RegExp(`^${REPAIR_TRAILER}:`, "m").test(msg) || /^Verified by Crashpad against /m.test(msg)) return `commit ${commit.slice(0, 12)} was created by Crashpad`;
  return null;
}

export function summarize(r: RepairResult, outDir: string): string {
  const lines = [`Crashpad repair: ${r.outcome.toUpperCase()} (exit ${r.exitCode})`, `  ${r.message}`, `  original:     ${r.original.headline}`];
  if (r.verification) lines.push(`  verification: ${r.verification.headline}`);
  for (const a of r.attempts) {
    const meta = a.agent ? ` [${a.agent.status}${a.agent.turns !== undefined ? `, ${a.agent.turns} turns` : ""}${a.agent.costUsd !== undefined ? `, est. $${a.agent.costUsd.toFixed(2)}` : ""}]` : "";
    lines.push(`  attempt ${a.attempt} (${a.proposer})${meta}: ${a.verdict} — ${a.reason}`);
    for (const v of a.violations) lines.push(`    rejected: ${v.path}: ${v.reason}`);
  }
  for (const f of r.files) lines.push(`  ${f.before === null ? "add" : f.after === null ? "delete" : "edit"}: ${f.path}`);
  if (r.preexistingTestFailures.length) lines.push(`  note: already failing before the change (not counted): ${r.preexistingTestFailures.join(", ")}`);
  lines.push(`  artifacts: ${outDir}`);
  return lines.join("\n") + "\n";
}

export async function cmdRepair(v: Values, cwd: string, agentOverride?: Agent): Promise<number> {
  if (!v.base) throw new UsageError("--base is required");
  const root = await repoRoot(cwd);
  const projectDir = projectDirFor(root, cwd, v.project);
  const remote = v.remote ?? "origin";
  const log = v.verbose ? (m: string) => process.stderr.write(`crashpad: ${m}\n`) : (m: string) => process.stderr.write(`crashpad: ${m}\n`);

  // The exact failing commit. With --branch, the remote branch tip (after fetch).
  let commit: string;
  let label: string;
  const branch = v.branch;
  if (branch) {
    if (v.publish) await git(root, ["fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    commit = await resolveCommit(root, v.publish ? `refs/remotes/${remote}/${branch}` : (v.head ?? branch));
    label = `\`${branch}\``;
  } else {
    if (!v.head) {
      const dirty = (await git(root, ["status", "--porcelain"])).stdout.trim();
      if (dirty) throw new UsageError("the working tree has uncommitted changes; repairs run on an exact commit. Commit first, or pass --head <ref>");
    }
    commit = await resolveCommit(root, v.head ?? "HEAD");
    label = `\`${v.head ?? "HEAD"}\``;
  }
  const baseCommit = await resolveCommit(root, v.base);
  const loop = await isCrashpadFix(root, branch, commit);
  if (loop) {
    process.stderr.write(`crashpad: refusing to repair: ${loop}. Crashpad never repairs its own fixes (loop prevention).\n`);
    return 2;
  }

  let agent: Agent | null = agentOverride ?? null;
  const agentName = v.agent ?? "none";
  if (!agent && agentName === "claude") {
    const auth = (v["claude-auth"] ?? "subscription") as ClaudeAuthMode;
    if (auth !== "subscription" && auth !== "existing") throw new UsageError("--claude-auth must be subscription or existing");
    agent = new ClaudeCodeAgent({ auth, ...(v.model ? { model: v.model } : {}) });
  } else if (!agent && agentName !== "none") throw new UsageError("--agent must be claude or none");

  const controller = new AbortController();
  const onSignal = () => {
    process.stderr.write("crashpad: cancelling repair…\n");
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result: RepairResult;
  try {
    const { settings, storedHttp } = await repoInputsFor(root);
    result = await repair({
      repoRoot: root,
      projectDir,
      base: { ref: v.base, commit: baseCommit },
      candidate: { label, commit },
      databaseUrl: databaseUrl(v["database-url"]),
      ...(settings ? { settings } : {}),
      ...(storedHttp ? { storedHttp } : {}),
      discover: v["no-discovery"] ? false : discoverer(),
      agent,
      maxAttempts: num(v["max-attempts"], 3, "max-attempts"),
      deadlineMs: num(v["deadline-min"], 30, "deadline-min") * 60_000,
      attemptTimeoutMs: num(v["attempt-timeout-min"], 10, "attempt-timeout-min") * 60_000,
      maxTurns: num(v["max-turns"], 40, "max-turns"),
      ...(v["max-budget-usd"] ? { maxBudgetUsd: num(v["max-budget-usd"], 1, "max-budget-usd") } : {}),
      deterministic: !v["no-deterministic"],
      signal: controller.signal,
      log,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const outDir = path.resolve(cwd, v.out ?? "crashpad-repair");
  await fs.mkdir(outDir, { recursive: true });
  await writeReport(outDir, result.original, renderSuiteMarkdown(result.original, { title: "Crashpad: original findings" }), "original-report");
  if (result.verification) await writeReport(outDir, result.verification, renderSuiteMarkdown(result.verification, { title: "Crashpad: verification of the proposed repair" }), "verification-report");
  const { original: _o, verification: _v, ...rest } = result;
  await fs.writeFile(path.join(outDir, "repair-result.json"), JSON.stringify({ ...rest, files: rest.files.map((f) => ({ path: f.path, change: f.before === null ? "add" : f.after === null ? "delete" : "edit" })) }, null, 2) + "\n");
  await fs.writeFile(path.join(outDir, "repair.patch"), result.patch);
  const repairId = randomUUID();
  const targetBranch = branch ?? "HEAD";
  await fs.writeFile(path.join(outDir, "pr-body.md"), repairBody(result, { branch: targetBranch, repairId }));
  process.stdout.write(summarize(result, outDir));

  if (v.apply && result.outcome === "verified") {
    if (branch || v.head) {
      process.stderr.write("crashpad: --apply only applies to the current checkout (omit --branch/--head)\n");
      return 2;
    }
    const head = await gitOut(root, ["rev-parse", "HEAD"]);
    if (head !== commit || (await git(root, ["status", "--porcelain"])).stdout.trim()) {
      process.stderr.write("crashpad: not applying: the checkout changed during the repair\n");
      return 2;
    }
    for (const f of result.files) {
      const abs = path.join(root, f.path);
      if (f.after === null) await fs.rm(abs);
      else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, f.after);
      }
    }
    process.stdout.write(`applied the verified repair to ${result.files.length} file(s) in the working tree\n`);
  }

  if (v.publish) {
    if (result.outcome !== "verified") {
      process.stderr.write(`crashpad: not publishing: the repair is ${result.outcome}, not verified\n`);
      return result.exitCode || 1;
    }
    if (!branch || !v.repo) throw new UsageError("--publish requires --branch and --repo");
    const { owner, repo } = parseRepo(v.repo);
    const remoteUrl = await gitOut(root, ["config", "--get", `remote.${remote}.url`]).catch(() => "");
    const parsed = parseGitHubRemote(remoteUrl);
    if (!parsed || `${parsed.owner}/${parsed.repo}`.toLowerCase() !== v.repo.toLowerCase()) {
      process.stderr.write(`crashpad: --repo ${v.repo} does not match remote "${remote}"\n`);
      return 2;
    }
    const token = v["dry-run"] ? null : await resolveToken();
    const pub = await publishFiles({
      repoRoot: root,
      remote,
      owner,
      repo,
      targetBranch: branch,
      targetCommit: commit,
      files: result.files,
      title: repairTitle(result, branch),
      body: repairBody(result, { branch, repairId }),
      commitMessage: [repairTitle(result, branch), `Verified by Crashpad against ${v.base} (${baseCommit.slice(0, 12)}).`, `${REPAIR_TRAILER}: ${repairId}`],
      api: token ? new FetchGitHubApi(token) : null,
      ...(v["dry-run"] ? { dryRun: true } : {}),
      log,
    });
    await fs.writeFile(path.join(outDir, "publish-result.json"), JSON.stringify(pub, null, 2) + "\n");
    process.stdout.write(`crashpad: ${pub.status}: ${pub.message}${pub.prUrl ? ` ${pub.prUrl}` : ""}\n`);
    if (pub.recovery) process.stdout.write(`  recovery: ${pub.recovery}\n`);
    return pub.exitCode;
  }
  return result.exitCode;
}
