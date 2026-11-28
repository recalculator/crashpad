import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { proposeAndVerify } from "../fix/pipeline.ts";
import { projectFromDatabaseConfig } from "../config.ts";
import { PgServer } from "../db/postgres.ts";
import { FsSource, GitSource } from "../source.ts";
import type { ConfigLayer, SuiteConfig } from "../suite/config.ts";
import { runSuite, type Discoverer, type StoredHttp } from "../suite/runner.ts";
import { ACTIONABLE } from "../report/types.ts";
import type { SuiteReport } from "../suite/types.ts";
import { TERMINAL, type Agent, type AgentRun } from "./agent.ts";
import { commandsOk, testsFromReport, type AppTestsResult } from "./app-tests.ts";
import { feedbackPrompt, initialPrompt } from "./prompt.ts";
import { violations, Workspace, type Violation } from "./workspace.ts";
import type { FileChange } from "../github/publish.ts";

/**
 * Repair = propose a change in an isolated workspace, then verify it
 * independently. The order of preference:
 *  1. the deterministic rename fixer (no model, no usage) when it applies;
 *  2. a repair agent (the user's Claude Code), for a bounded number of attempts,
 *     with each failed verification fed back to it.
 * Nothing is "fixed" until Crashpad's own checks pass against the ORIGINAL
 * expectations of the failing commit and the application's tests still pass.
 */

export type RepairOutcome = "verified" | "not-needed" | "unresolved" | "stopped" | "cannot-repair";

export interface RepairOptions {
  repoRoot: string;
  projectDir: string;
  base: { ref: string; commit: string };
  /** The exact failing commit (must be committed). */
  candidate: { label: string; commit: string };
  databaseUrl: string;
  settings?: ConfigLayer;
  /** Scenarios from Crashpad's storage, loaded once: every verification uses this same copy. */
  storedHttp?: StoredHttp;
  discover: Discoverer | false;
  agent: Agent | null;
  maxAttempts: number;
  /** Wall-clock limit for the whole repair. */
  deadlineMs: number;
  /** Wall-clock limit for one agent attempt. */
  attemptTimeoutMs: number;
  maxTurns: number;
  maxBudgetUsd?: number;
  /** Try the deterministic rename fixer before invoking an agent (default true). */
  deterministic?: boolean;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface AttemptRecord {
  attempt: number;
  proposer: string;
  agent?: Omit<AgentRun, "text">;
  changedFiles: string[];
  violations: Violation[];
  verification?: { exitCode: number; headline: string };
  tests?: AppTestsResult;
  verdict: "verified" | "rejected" | "stopped";
  reason: string;
}

export interface RepairResult {
  outcome: RepairOutcome;
  exitCode: 0 | 1 | 2;
  message: string;
  original: SuiteReport;
  verification: SuiteReport | null;
  attempts: AttemptRecord[];
  proposer: string | null;
  files: FileChange[];
  patch: string;
  /** Test commands that already failed before the change (reported, not required). */
  preexistingTestFailures: string[];
}

const RULES_TEXT = [
  "Crashpad configuration and check manifests",
  "application tests and test configuration",
  "migrations that already exist at this commit",
  "database bootstrap schema and sample data",
  "CI configuration",
  "package.json scripts",
];

/**
 * Whether a verification run shows the repair worked. Every regression must be
 * gone, nothing may newly fail or become undecided, and something must pass.
 * Findings that were ALREADY undecided in the original run (for example a baseline
 * failure the change did not cause) are allowed to remain: a repair of this change
 * cannot be expected to fix them, and they are reported.
 */
export function verifiedAgainst(original: SuiteReport, v: SuiteReport): { ok: boolean; reason: string } {
  if (v.problems.length) return { ok: false, reason: `could not complete: ${v.problems[0]!.message}` };
  const bad = v.findings.filter((f) => ACTIONABLE.has(f.classification));
  if (bad.length) return { ok: false, reason: `${bad.length} check(s) still broken: ${bad.slice(0, 3).map((f) => f.id).join(", ")}` };
  if (!v.findings.some((f) => f.classification === "pass")) return { ok: false, reason: "nothing passed" };
  const before = new Map(original.findings.map((f) => [f.id, f.classification]));
  const fresh = v.findings.filter((f) => f.classification !== "pass" && f.classification !== "retired" && before.get(f.id) !== f.classification);
  if (fresh.length) return { ok: false, reason: `${fresh.length} check(s) newly undecided: ${fresh.slice(0, 3).map((f) => `${f.id} (${f.classification})`).join(", ")}` };
  const kept = v.findings.filter((f) => f.classification !== "pass" && f.classification !== "retired");
  return { ok: true, reason: kept.length ? `${kept.length} pre-existing undecided check(s) unchanged (${kept.slice(0, 3).map((f) => f.id).join(", ")})` : "all checks pass" };
}

export async function repair(o: RepairOptions): Promise<RepairResult> {
  const log = o.log ?? (() => {});
  const started = Date.now();
  const deadline = started + o.deadlineMs;
  const baseSource = new GitSource(o.repoRoot, o.base.commit, `git ${o.base.ref}`);
  const origSource = new GitSource(o.repoRoot, o.candidate.commit, `git ${o.candidate.label}`);
  const attempts: AttemptRecord[] = [];
  const suite = (candidate: { label: string; source: FsSource | GitSource; code: { root: string; commit: string | null } }) =>
    runSuite({
      repoRoot: o.repoRoot,
      projectDir: o.projectDir,
      base: { ref: o.base.ref, commit: o.base.commit, source: baseSource },
      candidate: { label: candidate.label, commit: o.candidate.commit, source: candidate.source, code: candidate.code },
      // The original commit's expectations, whatever the patch does.
      expectations: origSource,
      databaseUrl: o.databaseUrl,
      ...(o.settings ? { settings: o.settings } : {}),
      ...(o.storedHttp ? { storedHttp: o.storedHttp } : {}),
      discover: o.discover,
      deadlineMs: Math.max(60_000, deadline - Date.now()),
      ...(o.signal ? { signal: o.signal } : {}),
      log,
    });

  log("reproducing the original failure");
  const orig = await suite({ label: o.candidate.label, source: origSource, code: { root: o.repoRoot, commit: o.candidate.commit } });
  const empty = { verification: null, attempts, proposer: null, files: [], patch: "", preexistingTestFailures: [] };
  if (orig.report.exitCode === 0) return { outcome: "not-needed", exitCode: 0, message: "All checks already pass; nothing to repair.", original: orig.report, ...empty };
  if (orig.report.problems.length) return { outcome: "cannot-repair", exitCode: 2, message: `The original run could not complete: ${orig.report.problems[0]!.message}`, original: orig.report, ...empty };
  if (!orig.report.findings.some((f) => ACTIONABLE.has(f.classification)) && !orig.report.projectCommands.results.some((c) => c.classification === "broken")) {
    return { outcome: "cannot-repair", exitCode: 2, message: `No actionable regression to repair: ${orig.report.headline}`, original: orig.report, ...empty };
  }
  const config = orig.candidateConfig as SuiteConfig;
  const guard = { repoRoot: o.repoRoot, commit: o.candidate.commit, projectDir: o.projectDir, config };
  // The suite runs the project's own build and test commands on the BASELINE and the
  // candidate. Commands already failing at the baseline are not the change's fault and are
  // not required; commands the change broke must pass again for a repair to count.
  const preexisting = orig.report.projectCommands.results.filter((c) => c.baseline.status === "fail").map((c) => c.command);

  const ws = await Workspace.create(o.repoRoot, o.candidate.commit);
  try {
    const verify = async (): Promise<{ report: SuiteReport; tests: AppTestsResult; ok: boolean }> => {
      log("verifying the proposed change independently");
      const v = await suite({ label: `${o.candidate.label} + proposed repair`, source: new FsSource(ws.dir, "repair workspace"), code: { root: ws.dir, commit: null } });
      const tests = testsFromReport(v.report);
      const testsOk = commandsOk(v.report);
      if (v.report.base.commit !== o.base.commit) throw new Error("internal: verification used a different baseline");
      return { report: v.report, tests, ok: verifiedAgainst(orig.report, v.report).ok && testsOk };
    };
    const finish = async (outcome: RepairOutcome, message: string, verification: SuiteReport | null, proposer: string | null): Promise<RepairResult> => {
      const files: FileChange[] = [];
      if (outcome === "verified") {
        for (const c of await ws.changes()) {
          const before = c.kind === "added" ? null : await new GitSource(o.repoRoot, o.candidate.commit).readFile(c.path);
          files.push({ path: c.path, before, after: c.kind === "deleted" ? null : await ws.read(c.path) });
        }
      }
      return {
        outcome,
        exitCode: outcome === "verified" ? 0 : outcome === "unresolved" ? 1 : 2,
        message,
        original: orig.report,
        verification,
        attempts,
        proposer,
        files,
        patch: outcome === "verified" ? await ws.diff() : "",
        preexistingTestFailures: preexisting,
      };
    };

    // ---- 1. Deterministic fast path: explicit column renames.
    if (o.deterministic !== false && orig.database && config.database) {
      const db = orig.database.report;
      if (db.checks.some((c) => ACTIONABLE.has(c.classification))) {
        const fix = await proposeAndVerify({
          projectDir: o.projectDir,
          base: { ref: o.base.ref, commit: o.base.commit, source: baseSource },
          candidate: { label: o.candidate.label, commit: o.candidate.commit, source: origSource },
          server: new PgServer(o.databaseUrl),
          loadProject: async (src, dir, side) => {
            const c = side === "base" ? orig.baseConfig?.database : config.database;
            return c ? projectFromDatabaseConfig(side === "base" ? baseSource : origSource, dir, c, "(effective)") : null;
          },
        });
        if (fix.outcome === "verified" && fix.proposal) {
          for (const e of fix.proposal.edits) await fs.writeFile(path.join(ws.dir, e.path), e.after);
          const v = await verify();
          const record: AttemptRecord = { attempt: 0, proposer: "rename-fixer", changedFiles: fix.proposal.edits.map((e) => e.path), violations: [], verification: { exitCode: v.report.exitCode, headline: v.report.headline }, tests: v.tests, verdict: v.ok ? "verified" : "rejected", reason: v.ok ? "all checks and tests pass" : v.report.headline };
          attempts.push(record);
          if (v.ok) return await finish("verified", "Verified by the deterministic rename fixer (no model used).", v.report, "rename-fixer");
          await ws.restore(fix.proposal.edits.map((e) => e.path));
          log("the rename fix alone does not make every area pass; continuing with the agent");
        }
      }
    }

    // ---- 2. Agent attempts.
    if (!o.agent) return await finish("unresolved", "No supported deterministic fix, and no repair agent was requested (use --agent claude).", null, null);
    const st = await o.agent.status();
    if (!st.ready) {
      attempts.push({ attempt: 1, proposer: o.agent.name, changedFiles: [], violations: [], verdict: "stopped", reason: st.message });
      return await finish("stopped", st.message, null, o.agent.name);
    }
    log(st.message);
    const sessionId = randomUUID();
    let prompt = initialPrompt({
      baseRef: o.base.ref,
      baseCommit: o.base.commit,
      commit: o.candidate.commit,
      report: orig.report,
      protectedRules: RULES_TEXT,
      testCommands: (config.tests ?? []).map((t) => t.join(" ")),
    });
    const allowedTools = ["Read", "Glob", "Grep", "Edit", "Write", "Bash(git diff *)", "Bash(git status *)", "Bash(ls *)", ...(config.tests ?? []).map((t) => `Bash(${t.join(" ")} *)`), ...(config.tests ?? []).map((t) => `Bash(${t.join(" ")})`)];
    let last: SuiteReport | null = null;
    for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return await finish("stopped", `Stopped: the repair deadline (${o.deadlineMs} ms) was reached after ${attempt - 1} attempt(s).`, last, o.agent.name);
      if (o.signal?.aborted) return await finish("stopped", "Cancelled.", last, o.agent.name);
      log(`agent attempt ${attempt}/${o.maxAttempts}`);
      const run = await o.agent.run({
        cwd: ws.dir,
        prompt,
        ...(attempt === 1 ? { sessionId } : { resumeSessionId: sessionId }),
        allowedTools,
        maxTurns: o.maxTurns,
        ...(o.maxBudgetUsd !== undefined ? { maxBudgetUsd: o.maxBudgetUsd } : {}),
        timeoutMs: Math.min(o.attemptTimeoutMs, remaining),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      const { text: _t, ...agentMeta } = run;
      const record: AttemptRecord = { attempt, proposer: o.agent.name, agent: agentMeta, changedFiles: [], violations: [], verdict: "rejected", reason: "" };
      attempts.push(record);
      if (TERMINAL.has(run.status)) {
        record.verdict = "stopped";
        record.reason = run.summary;
        return await finish("stopped", `Stopped: ${run.summary}`, last, o.agent.name);
      }
      // Whatever the agent says (including "completed"), only verification decides.
      const changes = await ws.changes();
      record.changedFiles = changes.map((c) => c.path);
      const bad = await violations(ws, guard);
      // Scenarios kept in Crashpad's storage live outside the workspace; they are expectations too.
      if (o.storedHttp) {
        const now = await fs.readFile(o.storedHttp.path, "utf8").catch(() => null);
        if (now !== o.storedHttp.raw) {
          await fs.writeFile(o.storedHttp.path, o.storedHttp.raw, { mode: 0o600 });
          bad.push({ path: o.storedHttp.path, reason: "runtime scenarios in Crashpad's storage are expectations and cannot be changed by a repair (restored)" });
          log(`restored ${o.storedHttp.path}, which the agent changed`);
        }
      }
      record.violations = bad;
      if (bad.length) {
        await ws.restore(bad.filter((v) => !path.isAbsolute(v.path)).map((v) => v.path));
        log(`rejected protected edits: ${bad.map((v) => v.path).join(", ")}`);
      }
      const remainingChanges = (await ws.changes()).length;
      if (!remainingChanges) {
        record.reason = bad.length ? "only protected files were changed (reverted)" : `no files changed (${run.status}: ${run.summary.slice(0, 200)})`;
        prompt = feedbackPrompt({ attempt, report: null, original: orig.report, violations: bad, tests: [], noChanges: !bad.length });
        continue;
      }
      const v = await verify();
      last = v.report;
      record.verification = { exitCode: v.report.exitCode, headline: v.report.headline };
      record.tests = v.tests;
      if (v.ok && !bad.length) {
        record.verdict = "verified";
        record.reason = v.report.exitCode === 0 ? "all checks pass against the original expectations, and the application tests pass" : `no regressions remain against the original expectations; ${verifiedAgainst(orig.report, v.report).reason}; the application tests pass`;
        return await finish("verified", `Verified after ${attempt} agent attempt(s).`, v.report, o.agent.name);
      }
      const judged = verifiedAgainst(orig.report, v.report);
      record.reason = bad.length ? "protected files were changed (reverted); the rest is re-verified next attempt" : !judged.ok ? judged.reason : "application tests failed";
      prompt = feedbackPrompt({ attempt, report: v.report, original: orig.report, violations: bad, tests: v.tests.results, ...(v.tests.problem ? { testProblem: v.tests.problem } : {}), noChanges: false });
    }
    return await finish("unresolved", `Unresolved after ${o.maxAttempts} attempt(s); no change passed verification. Nothing was published.`, last, o.agent.name);
  } finally {
    await ws.dispose();
  }
}
