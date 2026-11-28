import type { SuiteReport } from "../suite/types.ts";

export interface TestCommandResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface AppTestsResult {
  ran: boolean;
  /** Why the commands could not run on this version. */
  problem?: string;
  results: TestCommandResult[];
}

/**
 * The project's own build and test commands, as the suite ran them on the candidate
 * side of `report` (the suite runs them on both versions; see `projectCommands`).
 */
export function testsFromReport(report: SuiteReport): AppTestsResult {
  const results = report.projectCommands.results.map((c) => ({
    command: c.command,
    ok: c.candidate.status === "pass",
    exitCode: c.candidate.exitCode,
    timedOut: /timed out/.test(c.candidate.summary),
    durationMs: c.candidate.durationMs ?? 0,
    output: c.candidate.output ?? c.candidate.summary,
  }));
  const notRun = report.projectCommands.results.find((c) => c.candidate.status === "not-run");
  return { ran: results.some((r) => r.ok || r.exitCode !== null), ...(notRun ? { problem: notRun.candidate.summary } : {}), results };
}

/** Project commands that pass, or failed already at the baseline (not the change's fault). */
export function commandsOk(report: SuiteReport): boolean {
  return report.projectCommands.results.every((c) => c.classification === "pass" || c.classification === "fixed" || c.classification === "failing-at-baseline");
}
