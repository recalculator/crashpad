import type { CommandClassification, CommandSide, ProjectCommandResult, ProjectCommands } from "../suite/types.ts";
import type { CommandResult } from "./app.ts";

/**
 * The project's own build, typecheck, and test commands, compared baseline vs
 * candidate. These are the project's checks, not Crashpad's: a failing compiler says
 * nothing about database, API, permission, or workflow behavior, and the report keeps
 * them apart from the five areas.
 */

function lastLines(text: string, n: number): string {
  return text.trimEnd().split("\n").slice(-n).join("\n");
}

export function commandSide(r: CommandResult | null | undefined, notRun: string): CommandSide {
  if (!r) return { status: "not-run", summary: notRun, exitCode: null };
  if (r.ok) return { status: "pass", summary: `passed in ${Math.round(r.durationMs / 100) / 10}s`, exitCode: 0, durationMs: r.durationMs };
  const why = r.timedOut ? "timed out" : r.cancelled ? "cancelled" : `exit ${r.code ?? "none"}${r.signal ? `, signal ${r.signal}` : ""}`;
  return { status: "fail", summary: `failed (${why})`, exitCode: r.code, durationMs: r.durationMs, output: lastLines(r.output, 40) };
}

export function classifyCommand(b: CommandSide, c: CommandSide): { classification: CommandClassification; message: string } {
  if (c.status === "not-run") return { classification: "undecided", message: `Not run on the candidate: ${c.summary}` };
  if (c.status === "pass") {
    if (b.status === "fail") return { classification: "fixed", message: "Failed at the baseline; passes now" };
    return { classification: "pass", message: b.status === "pass" ? "Passes on both versions" : `Passes now (not run at the baseline: ${b.summary})` };
  }
  if (b.status === "pass") return { classification: "broken", message: "Passed at the baseline; fails now" };
  if (b.status === "fail") return { classification: "failing-at-baseline", message: "Already failing at the baseline; not blamed on this change" };
  return { classification: "undecided", message: `Fails now, and the baseline could not be run (${b.summary}), so it cannot be attributed` };
}

export function commandResult(command: string[], role: ProjectCommandResult["role"], b: CommandSide, c: CommandSide): ProjectCommandResult {
  return { command: command.join(" "), role, ...classifyCommand(b, c), baseline: b, candidate: c };
}

export function commandsHeadline(results: ProjectCommandResult[]): string {
  if (!results.length) return "none found";
  const n = (k: CommandClassification) => results.filter((r) => r.classification === k).length;
  const parts: string[] = [];
  if (n("broken")) parts.push(`${n("broken")} broken by this change`);
  if (n("pass")) parts.push(`${n("pass")} passed`);
  if (n("fixed")) parts.push(`${n("fixed")} fixed`);
  if (n("failing-at-baseline")) parts.push(`${n("failing-at-baseline")} already failing at the baseline`);
  if (n("undecided")) parts.push(`${n("undecided")} not decided`);
  return parts.join(", ");
}

export function emptyProjectCommands(missing: string[] = []): ProjectCommands {
  return { headline: "none run", results: [], missing };
}
