import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, gitOut, parseGitHubRemote, resolveCommit } from "../git.ts";
import type { PgServer } from "../db/postgres.ts";
import { FIX_PLAN_SCHEMA, proposeAndVerify, type FixPlan, type FixResult } from "../fix/pipeline.ts";
import { sha256 } from "../fix/patch.ts";
import { GitSource } from "../source.ts";
import type { GitHubApi } from "./client.ts";

export interface PublishOptions {
  repoRoot: string;
  projectDir: string;
  /** owner/name the user expects to publish to; must match the remote. */
  repo: string;
  /** Branch containing the change; the fix PR targets it. */
  branch: string;
  /** Baseline ref the change is compared against. */
  base: string;
  remote?: string;
  /** A fix-plan.json from an earlier `crashpad fix`; publishing refuses if it is stale. */
  plan?: FixPlan;
  dryRun?: boolean;
  /** Fetch the target branch from the remote first (default true). */
  fetch?: boolean;
  server: PgServer;
  api: GitHubApi | null;
  log?: (msg: string) => void;
}

export type PublishStatus = "opened" | "dry-run" | "refused" | "pushed-pr-failed";

export interface PublishResult {
  status: PublishStatus;
  exitCode: 0 | 1 | 2;
  message: string;
  branch?: string;
  commit?: string;
  prUrl?: string;
  recovery?: string;
  fix?: FixResult;
}

function refused(message: string, exitCode: 1 | 2 = 2, fix?: FixResult): PublishResult {
  return { status: "refused", exitCode, message, ...(fix ? { fix } : {}) };
}

export function fixBranchName(target: string, commit: string): string {
  const safe = target.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "branch";
  return `crashpad/fix-${safe}-${commit.slice(0, 8)}`;
}

/**
 * Publish a verified fix as a draft PR against the branch that contains the change.
 * The user's checkout (HEAD, index, working tree) is never touched: the commit is
 * made in a temporary `git worktree`, and only the verified files are committed.
 */
export async function publishFixPr(o: PublishOptions): Promise<PublishResult> {
  const log = o.log ?? (() => {});
  const remote = o.remote ?? "origin";
  const root = o.repoRoot;

  // 1. The target repository must be the configured remote.
  let remoteUrl: string;
  try {
    remoteUrl = await gitOut(root, ["remote", "get-url", remote]);
  } catch {
    return refused(`remote "${remote}" is not configured`);
  }
  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed || `${parsed.owner}/${parsed.repo}`.toLowerCase() !== o.repo.toLowerCase()) {
    return refused(`--repo ${o.repo} does not match remote "${remote}" (${parsed ? `${parsed.owner}/${parsed.repo}` : "not a GitHub remote"})`);
  }
  try {
    await git(root, ["check-ref-format", "--branch", o.branch]);
  } catch {
    return refused(`invalid branch name: ${o.branch}`);
  }

  // 2. Resolve the target branch tip from the remote, not from local state.
  if (o.fetch !== false) {
    log(`fetching ${remote}/${o.branch}`);
    await git(root, ["fetch", "--no-tags", remote, `+refs/heads/${o.branch}:refs/remotes/${remote}/${o.branch}`]);
  }
  let targetCommit: string;
  let baseCommit: string;
  try {
    targetCommit = await resolveCommit(root, `refs/remotes/${remote}/${o.branch}`);
    baseCommit = await resolveCommit(root, o.base);
  } catch (err) {
    return refused((err as Error).message);
  }

  // 3. Re-run detection, proposal, and verification right now, on committed content only.
  log(`verifying fix for ${o.branch} @ ${targetCommit.slice(0, 12)} against ${o.base} @ ${baseCommit.slice(0, 12)}`);
  const fix = await proposeAndVerify(
    {
      projectDir: o.projectDir,
      base: { ref: o.base, commit: baseCommit, source: new GitSource(root, baseCommit, `git ${o.base}`) },
      candidate: { label: `\`${o.branch}\``, commit: targetCommit, source: new GitSource(root, targetCommit, `git ${o.branch}`) },
      server: o.server,
    },
    { log },
  );
  if (fix.outcome !== "verified") {
    return refused(`fix is ${fix.outcome}, not verified; only fully verified patches are published (${fix.verification?.headline ?? fix.plan.notes.join(" ")})`, fix.exitCode === 0 ? 1 : fix.exitCode, fix);
  }

  // 4. A previously generated plan must still describe exactly this verified patch.
  if (o.plan) {
    if (o.plan.schemaVersion !== FIX_PLAN_SCHEMA) return refused(`unsupported fix plan schema ${o.plan.schemaVersion}`, 2, fix);
    if (!o.plan.publishable || o.plan.outcome !== "verified") return refused(`the supplied plan is ${o.plan.outcome}, not verified`, 2, fix);
    if (o.plan.base.commit !== baseCommit) return refused(`stale plan: it was verified against base ${o.plan.base.commit.slice(0, 12)}, not ${baseCommit.slice(0, 12)}`, 2, fix);
    if (o.plan.inputsDigest !== fix.plan.inputsDigest) return refused("stale plan: inputs (SQL sources, migrations, config, or checks) changed since it was verified", 2, fix);
    const key = (p: FixPlan) => JSON.stringify(p.edits.map((e) => [e.path, e.beforeSha256, e.afterSha256]).sort());
    if (key(o.plan) !== key(fix.plan)) return refused("stale plan: re-verification produced a different patch", 2, fix);
  }

  const branch = fixBranchName(o.branch, targetCommit);
  const remoteHas = (await git(root, ["ls-remote", "--heads", remote, `refs/heads/${branch}`])).stdout.trim();
  if (remoteHas) return refused(`branch ${branch} already exists on ${remote}; refusing to overwrite it (no force pushes)`, 2, fix);
  const localHas = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (localHas) return refused(`local branch ${branch} already exists; delete it or publish from a clean state`, 2, fix);

  if (o.dryRun) {
    return { status: "dry-run", exitCode: 0, message: `verified; would push ${branch} and open a draft PR into ${o.branch}`, branch, fix };
  }
  if (!o.api) return refused("no GitHub token available to open the pull request", 2, fix);

  // 5. Commit only the intended files in an isolated worktree.
  const edits = fix.proposal!.edits;
  const intended = edits.map((e) => e.path).sort();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crashpad-fixpr-"));
  let commit: string;
  let pushed = false;
  try {
    await git(root, ["worktree", "add", "--detach", dir, targetCommit]);
    await git(dir, ["switch", "-c", branch]);
    for (const e of edits) {
      const abs = path.join(dir, e.path);
      const current = await fs.readFile(abs, "utf8");
      if (sha256(current) !== sha256(e.before)) throw new Error(`${e.path} at ${targetCommit.slice(0, 12)} does not match the verified input`);
      await fs.writeFile(abs, e.after);
    }
    await git(dir, ["add", "--", ...intended]);
    const status = (await git(dir, ["status", "--porcelain", "--untracked-files=all"])).stdout.split("\n").filter(Boolean);
    const touched = status.map((l) => l.slice(3)).sort();
    if (JSON.stringify(touched) !== JSON.stringify(intended) || status.some((l) => !l.startsWith("M "))) {
      throw new Error(`worktree contains unexpected changes: ${status.join(", ")}`);
    }
    const identity = await commitIdentity(dir);
    await git(dir, [...identity, "commit", "--no-verify", "-m", fix.prTitle, "-m", `Verified by Crashpad against ${o.base} (${baseCommit.slice(0, 12)}).\nInputs digest: ${fix.plan.inputsDigest}`]);
    commit = await gitOut(dir, ["rev-parse", "HEAD"]);
    const changed = (await gitOut(dir, ["diff", "--name-only", targetCommit, commit])).split("\n").filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(intended)) throw new Error(`commit touches unexpected files: ${changed.join(", ")}`);

    // 6. Push a brand-new branch, never forcing.
    log(`pushing ${branch}`);
    await git(dir, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    pushed = true;
  } catch (err) {
    return refused(`could not prepare or push the fix branch: ${(err as Error).message}`, 2, fix);
  } finally {
    await git(root, ["worktree", "remove", "--force", dir]).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (pushed) await git(root, ["branch", "-D", branch]).catch(() => {});
  }

  // 7. Open the draft PR. If this fails, the pushed branch is the recovery point.
  const { owner, repo } = parsed;
  try {
    const pr = await o.api.createPullRequest(owner, repo, { title: fix.prTitle, body: fix.prBody, head: branch, base: o.branch, draft: true });
    return { status: "opened", exitCode: 0, message: `opened draft PR #${pr.number}`, branch, commit, prUrl: pr.html_url, fix };
  } catch (err) {
    const recovery = `gh pr create --repo ${owner}/${repo} --draft --base ${o.branch} --head ${branch} --title ${JSON.stringify(fix.prTitle)} --body-file pr-body.md`;
    return {
      status: "pushed-pr-failed",
      exitCode: 2,
      message: `branch ${branch} was pushed (commit ${commit.slice(0, 12)}) but creating the pull request failed: ${(err as Error).message}`,
      branch,
      commit,
      recovery,
      fix,
    };
  }
}

async function commitIdentity(dir: string): Promise<string[]> {
  const email = await gitOut(dir, ["config", "user.email"]).catch(() => "");
  const name = await gitOut(dir, ["config", "user.name"]).catch(() => "");
  if (email && name) return [];
  return ["-c", `user.name=${process.env.CRASHPAD_GIT_NAME ?? "crashpad[bot]"}`, "-c", `user.email=${process.env.CRASHPAD_GIT_EMAIL ?? "crashpad-bot@users.noreply.github.com"}`];
}
