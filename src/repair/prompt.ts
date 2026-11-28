import type { Finding, SuiteReport } from "../suite/types.ts";
import { AREA_TITLES } from "../suite/types.ts";
import type { TestCommandResult } from "./app-tests.ts";
import type { Violation } from "./workspace.ts";

const ACTIONABLE = new Set(["regression", "changed-result", "failed-assertion", "removed"]);

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s;
}

export function describeFindings(report: SuiteReport, limit = 12): string {
  const bad = report.findings.filter((f) => ACTIONABLE.has(f.classification));
  const lines: string[] = [];
  for (const f of bad.slice(0, limit)) lines.push(describeFinding(f));
  if (bad.length > limit) lines.push(`…and ${bad.length - limit} more failing check(s).`);
  return lines.join("\n\n");
}

function describeFinding(f: Finding): string {
  const where = [f.subject.file ? `${f.subject.file}${f.subject.line ? `:${f.subject.line}` : ""}` : null, f.subject.operation].filter(Boolean).join(" · ");
  const ev = f.evidence
    .filter((e) => e.side !== "baseline")
    .slice(0, 4)
    .map((e) => `  - ${e.label}:\n${clip(e.detail, 1200).replace(/^/gm, "      ")}`)
    .join("\n");
  return [`### ${f.id} (${AREA_TITLES[f.area]}, ${f.classification})`, `${f.title}${where ? ` — ${where}` : ""}`, f.message, `Baseline: ${f.baseline.summary}`, `Now: ${f.candidate.summary}`, ev ? `Evidence:\n${ev}` : ""].filter(Boolean).join("\n");
}

/** The project's own commands that the change broke (they passed at the baseline). */
export function describeBrokenCommands(report: SuiteReport): string {
  return report.projectCommands.results
    .filter((c) => c.classification === "broken")
    .map((c) => `### \`${c.command}\` (the project's ${c.role} command)\nPassed at the baseline; fails now (${c.candidate.summary}).${c.candidate.output ? `\nOutput (last lines):\n${clip(c.candidate.output, 2500).replace(/^/gm, "    ")}` : ""}`)
    .join("\n\n");
}

export interface PromptContext {
  baseRef: string;
  baseCommit: string;
  commit: string;
  report: SuiteReport;
  protectedRules: string[];
  testCommands: string[];
}

export function initialPrompt(c: PromptContext): string {
  return `You are repairing a regression that Crashpad reproduced in this repository.

This directory is an isolated copy of the repository at commit ${c.commit}, the version that fails. Crashpad compared it with the baseline ${c.baseRef} (${c.baseCommit.slice(0, 12)}), on which these checks pass, by building real databases, running the application, and running the configured checks on both versions.

## Failing checks

${describeFindings(c.report) || "None of Crashpad's own checks fail; see the project commands below."}
${describeBrokenCommands(c.report) ? `\n## Project commands broken by this change\n\n${describeBrokenCommands(c.report)}\n` : ""}
## What to do

1. Inspect the relevant application source and find the cause of each failure.
2. Edit the application source so the original expectations hold again. Keep the intended change working where possible.
3. ${c.testCommands.length ? `You may run the application's tests: ${c.testCommands.map((t) => `\`${t}\``).join(", ")}.` : "There are no configured application test commands."}
4. Finish with a short summary of the cause and what you changed.

## Rules (Crashpad enforces them)

- Crashpad verifies your change independently. It re-runs every check against the ORIGINAL expectations of commit ${c.commit.slice(0, 12)} and runs the application's tests. Your own report of success is not taken as evidence.
- Do not edit, delete, or weaken: ${c.protectedRules.join("; ")}. Changes to these are rejected and reverted.
- Do not disable checks, skip tests, or change expected contracts, status codes, or assertions to match the new behavior.
- If the behavior change is intended and the expectations themselves should change, do not edit anything: say so in your summary, because that decision belongs to a reviewer.
- Do not commit, push, or access the network.`;
}

export function feedbackPrompt(opts: { attempt: number; report: SuiteReport | null; original?: SuiteReport; violations: Violation[]; tests: TestCommandResult[]; testProblem?: string; noChanges: boolean }): string {
  const parts: string[] = [`Crashpad verified attempt ${opts.attempt} independently and it did not pass.`];
  if (opts.noChanges) parts.push("You did not change any files.");
  if (opts.violations.length) {
    parts.push(`These changes were rejected and reverted because they touch protected files:\n${opts.violations.map((v) => `- ${v.path}: ${v.reason}`).join("\n")}`);
  }
  if (opts.report && opts.report.exitCode !== 0) {
    const failing = describeFindings(opts.report, 8);
    if (failing) parts.push(`Checks still failing (${opts.report.headline}):\n\n${failing}`);
    // Checks that could not be decided now but were fine before also block verification; name them.
    const before = new Map((opts.original?.findings ?? []).map((f) => [f.id, f.classification]));
    const undecided = opts.report.findings.filter((f) => !ACTIONABLE.has(f.classification) && f.classification !== "pass" && f.classification !== "retired" && before.get(f.id) !== f.classification);
    if (undecided.length) parts.push(`Checks that could not be decided after your change (they were not like this before):\n\n${undecided.slice(0, 8).map((f) => describeFinding(f)).join("\n\n")}`);
  }
  if (opts.testProblem) parts.push(`The application tests could not run: ${clip(opts.testProblem, 1500)}`);
  for (const t of opts.tests.filter((x) => !x.ok)) parts.push(`Application test command \`${t.command}\` failed (exit ${t.exitCode}${t.timedOut ? ", timed out" : ""}):\n${clip(t.output, 2500)}`);
  parts.push("Continue from where you left off: fix the remaining problems in the application source, following the same rules.");
  return parts.join("\n\n");
}
