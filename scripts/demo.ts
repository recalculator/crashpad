/**
 * Full local demonstration. Every scenario runs the real CLI against a real
 * PostgreSQL server and a real Git repository; nothing here is a canned report.
 *
 *   npm run demo                 # all scenarios
 *   npm run demo -- 06-rename-fix
 *   npm run demo -- --keep       # keep the temporary repositories for inspection
 *
 * Intentionally broken scenarios are EXPECTED to make `crashpad check` exit 1.
 * The demo itself exits 0 only if every scenario behaves exactly as expected.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildScenarioRepo, CRASHPAD_ROOT, loadScenarios, sh, type Scenario } from "./lib/scenario.ts";

const CLI = path.join(CRASHPAD_ROOT, "bin/crashpad.js");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const only = args.filter((a) => !a.startsWith("--"));

if (!fs.existsSync(path.join(CRASHPAD_ROOT, "dist/cli.js"))) {
  console.error("dist/ is missing: run `npm install` (which builds) or `npm run build` first.");
  process.exit(2);
}

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

interface Outcome {
  name: string;
  title: string;
  expected: number;
  actual: number;
  problems: string[];
  dir: string;
}

function run(cwd: string, cmd: string, argv: string[]) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", env: process.env });
  return { code: r.status ?? 2, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function crashpad(cwd: string, argv: string[]) {
  return run(cwd, process.execPath, [CLI, ...argv]);
}

function explainExit(code: number, expected: number): string {
  const meaning = code === 0 ? "all checks pass" : code === 1 ? "actionable regression found" : "could not decide (config/baseline/infrastructure/inconclusive)";
  const verdict = code === expected ? green(code === 0 ? "as expected" : "EXPECTED — this scenario breaks the app on purpose") : red(`UNEXPECTED (wanted ${expected})`);
  return `exit ${code} (${meaning}) — ${verdict}`;
}

function verifyReport(s: Scenario, report: any, problems: string[]): void {
  const byId = new Map<string, any>(report.checks.map((c: any) => [c.id, c]));
  for (const [id, cls] of Object.entries(s.expect ?? {})) {
    const got = byId.get(id)?.classification;
    if (got !== cls) problems.push(`${id}: expected ${cls}, got ${got ?? "missing"}`);
  }
  for (const id of s.expectNew ?? []) if (!byId.get(id)?.isNew) problems.push(`${id}: expected to be reported as a new check`);
  for (const [id, code] of Object.entries(s.expectErrorCode ?? {})) {
    const got = byId.get(id)?.candidate?.error?.code;
    if (got !== code) problems.push(`${id}: expected PostgreSQL error ${code}, got ${got ?? "none"}`);
  }
}

function printFindings(report: any): void {
  console.log(`  ${bold(report.headline)}`);
  for (const m of report.migrations.new) console.log(`  migration ${m.file}: ${m.status}${m.error ? ` (${m.error.code} ${m.error.message})` : ""}`);
  for (const c of report.checks) {
    if (c.classification === "pass" && !c.isNew) continue;
    const err = c.candidate.error ? ` [${c.candidate.error.code}] ${c.candidate.error.message}` : "";
    const at = c.candidate.error?.at ? dim(` @ ${c.candidate.error.at.path}:${c.candidate.error.at.line}:${c.candidate.error.at.column}`) : "";
    console.log(`  - ${c.id} (${c.category}${c.isNew ? ", new" : ""}): ${c.classification} — ${c.message.replace(/\s+—.*$/, "")}${err}${at}`);
  }
  const passing = report.checks.filter((c: any) => c.classification === "pass").length;
  console.log(dim(`  (${passing}/${report.checks.length} checks pass)`));
}

function checkScenario(s: Scenario, repo: string, problems: string[]): number {
  const reportDir = path.join(path.dirname(repo), "report");
  const r = crashpad(repo, ["check", "--base", "main", "--report-dir", reportDir]);
  if (!fs.existsSync(path.join(reportDir, "crashpad-report.json"))) {
    problems.push(`no report produced: ${r.stderr.trim()}`);
    return r.code;
  }
  const report = JSON.parse(fs.readFileSync(path.join(reportDir, "crashpad-report.json"), "utf8"));
  printFindings(report);
  verifyReport(s, report, problems);
  console.log(`  crashpad check: ${explainExit(r.code, s.mode === "fix" ? 1 : s.expectedExit)}`);
  console.log(dim(`  report: ${path.join(reportDir, "crashpad-report.md")}`));
  return r.code;
}

function backendTests(cwd: string): { ok: boolean; summary: string } {
  const r = run(cwd, process.execPath, ["--test", "--test-reporter=spec", ...fs.readdirSync(path.join(cwd, "test")).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`)]);
  const pass = r.stdout.match(/ℹ pass (\d+)/)?.[1] ?? "?";
  const fail = r.stdout.match(/ℹ fail (\d+)/)?.[1] ?? "?";
  const firstError = r.stdout.match(/error: '([^']+)'/)?.[1] ?? r.stdout.match(/column "[^"]+" does not exist/)?.[0];
  return { ok: r.code === 0, summary: `${pass} passed, ${fail} failed${firstError ? ` (e.g. ${firstError})` : ""}` };
}

function fixScenario(s: Scenario, repo: string, problems: string[]): number {
  console.log(bold("  1. The change is broken:"));
  const checkCode = checkScenario(s, repo, problems);
  if (checkCode !== 1) problems.push(`pre-fix check should exit 1, got ${checkCode}`);
  const before = backendTests(repo);
  console.log(`  storefront integration tests on the change branch: ${before.ok ? red("PASS (unexpected)") : green("FAIL as expected")} — ${before.summary}`);
  if (before.ok) problems.push("storefront tests should fail before the fix");

  console.log(bold("  2. crashpad fix proposes and verifies a patch:"));
  const fixDir = path.join(path.dirname(repo), "fix");
  const headBefore = sh(repo, "git", ["rev-parse", "HEAD"]).trim();
  const f = crashpad(repo, ["fix", "--base", "main", "--out", fixDir]);
  process.stdout.write(f.stdout.replace(/^/gm, "  "));
  if (f.code !== s.expectedExit) problems.push(`crashpad fix exited ${f.code}, expected ${s.expectedExit}: ${f.stderr.trim()}`);
  const planPath = path.join(fixDir, "fix-plan.json");
  if (!fs.existsSync(planPath)) {
    problems.push("no fix plan written");
    return f.code;
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (plan.outcome !== s.expectOutcome) problems.push(`fix outcome ${plan.outcome}, expected ${s.expectOutcome}`);
  const edited = plan.edits.map((e: any) => e.path).sort();
  if (JSON.stringify(edited) !== JSON.stringify([...(s.expectEdited ?? [])].sort())) problems.push(`edited ${edited.join(", ")}`);
  const verification = JSON.parse(fs.readFileSync(path.join(fixDir, "verification-report.json"), "utf8"));
  console.log(`  verification (original baseline queries vs patched candidate): ${bold(verification.headline)}`);
  console.log(dim(`  patch: ${path.join(fixDir, "fix.patch")}`));
  console.log(fs.readFileSync(path.join(fixDir, "fix.patch"), "utf8").replace(/^/gm, "    "));

  console.log(bold("  3. Apply the patch in an isolated worktree and run the storefront's own tests:"));
  const wt = path.join(path.dirname(repo), "fix-workspace");
  sh(repo, "git", ["worktree", "add", "-q", "-b", "crashpad-demo-fixed", wt, "change"]);
  sh(wt, "git", ["apply", "--index", path.join(fixDir, "fix.patch")]);
  fs.symlinkSync(path.join(CRASHPAD_ROOT, "node_modules"), path.join(wt, "node_modules"), "dir");
  const after = backendTests(wt);
  console.log(`  storefront integration tests with the patch: ${after.ok ? green("PASS") : red("FAIL")} — ${after.summary}`);
  if (!after.ok) problems.push("storefront tests should pass after the verified patch");
  const recheck = crashpad(wt, ["check", "--base", "main"]);
  console.log(`  crashpad check in the patched worktree: ${explainExit(recheck.code, 0)}`);
  if (recheck.code !== 0) problems.push(`patched worktree check exited ${recheck.code}`);

  const status = sh(repo, "git", ["status", "--porcelain"]).trim();
  const headAfter = sh(repo, "git", ["rev-parse", "HEAD"]).trim();
  const untouched = status === "" && headAfter === headBefore;
  console.log(`  original checkout untouched (clean status, same HEAD): ${untouched ? green("yes") : red("no")}`);
  if (!untouched) problems.push(`original checkout changed: status=${JSON.stringify(status)}`);
  return f.code;
}

const scenarios = loadScenarios().filter((s) => only.length === 0 || only.includes(s.name));
const outcomes: Outcome[] = [];
for (const s of scenarios) {
  console.log(`\n${bold(`━━ ${s.name}: ${s.title}`)}`);
  console.log(dim(`  ${s.story}`));
  const problems: string[] = [];
  const repo = buildScenarioRepo(s);
  const actual = s.mode === "fix" ? fixScenario(s, repo, problems) : checkScenario(s, repo, problems);
  for (const p of problems) console.log(red(`  ✗ ${p}`));
  outcomes.push({ name: s.name, title: s.title, expected: s.expectedExit, actual, problems, dir: path.dirname(repo) });
  if (!keep && problems.length === 0) fs.rmSync(path.dirname(repo), { recursive: true, force: true });
}

console.log(`\n${bold("Summary")}`);
console.log("  scenario                       mode   expected exit  actual exit  behaved as expected");
for (const o of outcomes) {
  const s = scenarios.find((x) => x.name === o.name)!;
  const ok = o.problems.length === 0 && o.actual === o.expected;
  console.log(`  ${o.name.padEnd(30)} ${s.mode.padEnd(6)} ${String(o.expected).padEnd(14)} ${String(o.actual).padEnd(12)} ${ok ? green("yes") : red("NO")}${ok && !keep ? "" : dim(`  (${o.dir})`)}`);
}
console.log(dim("\n  Exit 1 from `crashpad check` is the correct result for scenarios 02–05 and for scenario 06 before the fix."));
const failed = outcomes.filter((o) => o.problems.length || o.actual !== o.expected);
console.log(failed.length ? red(`\n${failed.length} scenario(s) did not behave as expected`) : green(`\nAll ${outcomes.length} scenarios behaved as expected.`));
process.exit(failed.length ? 1 : 0);
