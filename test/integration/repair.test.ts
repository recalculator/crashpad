import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { discoverer } from "../../src/discovery/index.ts";
import { git, gitOut } from "../../src/git.ts";
import { publishFiles } from "../../src/github/publish.ts";
import { ClaudeCodeAgent, pickAuthFields } from "../../src/repair/claude.ts";
import { repair, type RepairOptions } from "../../src/repair/loop.ts";
import { isCrashpadFix } from "../../src/commands/repair.ts";
import type { Agent } from "../../src/repair/agent.ts";
import { DB_URL, tempDir } from "../helpers/project.ts";
import { buildScenarioRepo, loadScenarios, NOTES_API, NOTES_SCENARIOS } from "../helpers/scenario.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";

/**
 * Repair tests. The agent here is a MOCK: `test/fixtures/fake-claude/claude` imitates
 * the Claude Code CLI's process contract (flags, JSON result, error output) and applies
 * scripted edits. These tests prove the adapter's process handling and that Crashpad's
 * independent verification decides the outcome; they do not prove the live Claude
 * integration works (see docs/validation.md for the live run).
 */

const FAKE = path.resolve(import.meta.dirname, "../fixtures/fake-claude/claude");

beforeAll(() => {
  process.env.CRASHPAD_HOME = tempDir("crashpad-home-");
});

function fakeAgent(mode: string, extra: Record<string, string> = {}) {
  const log = path.join(tempDir(), "claude-calls.jsonl");
  const agent = new ClaudeCodeAgent({ bin: FAKE, env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, ...extra } });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { agent, calls };
}

function scenarioRepo(name: string): { repo: string; base: string; commit: string } {
  const s = loadScenarios(NOTES_SCENARIOS).find((x) => x.name === name)!;
  const repo = buildScenarioRepo(s, tempDir(), NOTES_API);
  return { repo, base: "main", commit: "" };
}

async function opts(repo: string, agent: Agent | null, over: Partial<RepairOptions> = {}): Promise<RepairOptions> {
  return {
    repoRoot: repo,
    projectDir: ".",
    base: { ref: "main", commit: await gitOut(repo, ["rev-parse", "main"]) },
    candidate: { label: "change", commit: await gitOut(repo, ["rev-parse", "change"]) },
    databaseUrl: DB_URL,
    discover: discoverer(),
    agent,
    maxAttempts: 2,
    deadlineMs: 10 * 60_000,
    attemptTimeoutMs: 60_000,
    maxTurns: 10,
    ...over,
  };
}

describe("Claude Code adapter (mock CLI process)", () => {
  it("checks installation and sign-in through supported CLI output, keeping no account details", async () => {
    expect((await new ClaudeCodeAgent({ bin: "/nonexistent/claude" }).status()).reason).toBe("not-installed");
    expect((await fakeAgent("noop", { FAKE_CLAUDE_AUTH: "none" }).agent.status()).reason).toBe("not-authenticated");
    const apiKey = await fakeAgent("noop", { FAKE_CLAUDE_AUTH: "api_key" }).agent.status();
    expect(apiKey.ready).toBe(false);
    expect(apiKey.message).toMatch(/not a Claude subscription/);
    expect((await fakeAgent("noop", { FAKE_CLAUDE_EXPIRES: "2001-01-01T00:00:00Z" }).agent.status()).message).toMatch(/expired/);
    const ok = await fakeAgent("noop").agent.status();
    expect(ok).toMatchObject({ ready: true, version: "9.9.9" });
    expect(JSON.stringify(ok)).not.toMatch(/someone@example|orgName|"Org"/);
    expect(pickAuthFields({ loggedIn: true, email: "x@y", orgId: "1", authMethod: "claude.ai" })).toEqual({ loggedIn: true, authMethod: "claude.ai", apiProvider: null, loginExpiresAt: null, subscriptionType: null });
  });

  it("never passes permission-bypass or API-key-only flags, and strips env API keys for subscription auth", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
    try {
      const { agent, calls } = fakeAgent("claims-success");
      const args = agent.args({ cwd: ".", prompt: "x", allowedTools: ["Read", "Edit"], maxTurns: 5, timeoutMs: 1000, maxBudgetUsd: 0.5 });
      for (const bad of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--bare"]) expect(args).not.toContain(bad);
      expect(args).toEqual(expect.arrayContaining(["-p", "--permission-mode", "dontAsk", "--strict-mcp-config", "--max-turns", "5", "--max-budget-usd", "0.5", "--output-format", "json"]));
      const r = await agent.run({ cwd: tempDir(), prompt: "x", allowedTools: ["Read"], maxTurns: 5, timeoutMs: 20_000 });
      expect(r).toMatchObject({ status: "completed", turns: 3 });
      expect(calls().at(-1)).toMatchObject({ apiKeyPresent: false, authTokenPresent: false });
      const existing = new ClaudeCodeAgent({ bin: FAKE, auth: "existing" });
      expect("ANTHROPIC_API_KEY" in existing.childEnv()).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("classifies expired sessions, exhausted usage, turn limits, deadlines, and cancellation", async () => {
    const run = (mode: string, timeoutMs = 20_000, signal?: AbortSignal) => fakeAgent(mode).agent.run({ cwd: tempDir(), prompt: "x", allowedTools: [], maxTurns: 2, timeoutMs, ...(signal ? { signal } : {}) });
    expect((await run("expired")).status).toBe("not-authenticated");
    expect((await run("usage")).status).toBe("usage-exhausted");
    expect((await run("max-turns")).status).toBe("limit");
    expect((await run("hang", 800)).status).toBe("deadline");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect((await run("hang", 30_000, ac.signal)).status).toBe("cancelled");
  });
});

describe("repair loop with independent verification (real checks, mock agent)", () => {
  it("rejects an incorrect patch, feeds the failure back, and accepts the corrected one only after verification", async () => {
    const { repo } = scenarioRepo("n05-permission-regression");
    const { agent, calls } = fakeAgent("wrong-then-right");
    const r = await repair(await opts(repo, agent));
    expect(r.outcome, JSON.stringify(r.attempts, null, 2)).toBe("verified");
    expect(r.attempts.map((a) => a.verdict)).toEqual(["rejected", "verified"]);
    expect(r.attempts[0]!.verification?.exitCode).toBe(1);
    expect(r.attempts[0]!.reason).toMatch(/broke/);
    expect(r.files.map((f) => f.path)).toEqual(["server.js"]);
    expect(r.patch).toContain('user.role !== "admin"');
    expect(r.verification?.exitCode).toBe(0);
    const c = calls().filter((x) => x.args[0] === "-p");
    expect(c).toHaveLength(2);
    expect(c[1].args).toContain("--resume");
    expect(c[1].args[1]).toMatch(/did not pass/);
    expect(c[1].args[1]).toMatch(/permissions:note-visible-to-owner-and-admin/);
    // The user's repository is untouched.
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("");
  });

  it("does not accept a successful exit without a fix", async () => {
    const { repo } = scenarioRepo("n05-permission-regression");
    const r = await repair(await opts(repo, fakeAgent("claims-success").agent));
    expect(r.outcome).toBe("unresolved");
    expect(r.attempts.every((a) => a.agent?.status === "completed" && a.verdict === "rejected")).toBe(true);
    expect(r.files).toEqual([]);
  });

  it("reverts edits to expectations and tests and never counts them", async () => {
    const { repo } = scenarioRepo("n05-permission-regression");
    const r = await repair(await opts(repo, fakeAgent("cheat").agent, { maxAttempts: 1 }));
    expect(r.outcome).toBe("unresolved");
    expect(r.attempts[0]!.violations.map((v) => v.path).sort()).toEqual(["crashpad.http.json", "test/api.test.js"]);
    expect(r.attempts[0]!.reason).toMatch(/only protected files/);
  });

  it("stops clearly when usage is exhausted or Claude Code is not signed in", async () => {
    const { repo } = scenarioRepo("n05-permission-regression");
    const usage = await repair(await opts(repo, fakeAgent("usage").agent));
    expect(usage).toMatchObject({ outcome: "stopped", exitCode: 2 });
    expect(usage.message).toMatch(/usage limits/);
    const signedOut = await repair(await opts(repo, fakeAgent("fix-permission", { FAKE_CLAUDE_AUTH: "none" }).agent));
    expect(signedOut.outcome).toBe("stopped");
    expect(signedOut.message).toMatch(/not signed in/);
  });

  it("uses the deterministic rename fixer first, with no agent call", async () => {
    const { repo } = scenarioRepo("n02-db-rename-breaks-app");
    const never: Agent = { name: "never", status: async () => ({ ready: true, message: "" }), run: async () => { throw new Error("agent must not be invoked"); } };
    const r = await repair(await opts(repo, never));
    expect(r.outcome, JSON.stringify(r.attempts, null, 2)).toBe("verified");
    expect(r.proposer).toBe("rename-fixer");
    expect(r.files.map((f) => f.path)).toEqual(["sql/list_products.sql"]);
    expect(r.files[0]!.after).toContain("title AS name");
  });

  it("publishes a verified repair as a draft PR on top of the exact failing commit; never repairs its own fix branches", async () => {
    const { repo } = scenarioRepo("n05-permission-regression");
    const bare = tempDir();
    await git(bare, ["init", "-q", "--bare"]);
    await git(repo, ["remote", "add", "origin", "https://github.com/acme/notes.git"]);
    await git(repo, ["config", `url.${bare}.insteadOf`, "https://github.com/acme/notes.git"]);
    await git(repo, ["push", "-q", "origin", "main", "change"]);
    const o = await opts(repo, fakeAgent("fix-permission").agent);
    const r = await repair(o);
    expect(r.outcome).toBe("verified");
    const gh = new FakeGitHub();
    const pub = await publishFiles({ repoRoot: repo, remote: "origin", owner: "acme", repo: "notes", targetBranch: "change", targetCommit: o.candidate.commit, files: r.files, title: "t", body: "b", commitMessage: ["t", "Crashpad-Repair: x"], api: gh });
    expect(pub.status).toBe("opened");
    expect(gh.prs[0]).toMatchObject({ base: "change", draft: true, head: pub.branch });
    expect(await gitOut(bare, ["rev-parse", `${pub.branch}^`])).toBe(o.candidate.commit);
    expect(await gitOut(bare, ["diff", "--name-only", o.candidate.commit, pub.branch!])).toBe("server.js");
    // The same branch is never overwritten, and Crashpad's own fix commits are never repaired.
    expect((await publishFiles({ repoRoot: repo, remote: "origin", owner: "acme", repo: "notes", targetBranch: "change", targetCommit: o.candidate.commit, files: r.files, title: "t", body: "b", commitMessage: ["t"], api: gh })).status).toBe("refused");
    await git(repo, ["fetch", "-q", "origin", `${pub.branch}:${pub.branch}`]);
    expect(await isCrashpadFix(repo, pub.branch, await gitOut(repo, ["rev-parse", pub.branch!]))).toMatch(/Crashpad fix branch/);
    expect(await isCrashpadFix(repo, "feature", await gitOut(repo, ["rev-parse", pub.branch!]))).toMatch(/created by Crashpad/);
  });
});
