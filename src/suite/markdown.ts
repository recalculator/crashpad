import type { Classification } from "../report/types.ts";
import { cell } from "../report/markdown.ts";
import { AREA_TITLES, type CommandClassification, type CoverageStatus, type Finding, type SuiteReport } from "./types.ts";

export const SUITE_COMMENT_MARKER = "<!-- crashpad-report -->";

const LABEL: Record<Classification, string> = {
  pass: "✅ pass",
  regression: "❌ regression",
  "changed-result": "❌ changed result",
  "failed-assertion": "❌ failed assertion",
  "baseline-failure": "⚠️ existing baseline failure",
  "invalid-fixture": "⚠️ invalid check",
  inconclusive: "⚠️ inconclusive",
  skipped: "⏭️ skipped",
  removed: "❌ removed (needs review)",
  retired: "ℹ️ retired",
};

const ORDER: Classification[] = ["regression", "changed-result", "failed-assertion", "removed", "baseline-failure", "invalid-fixture", "inconclusive", "skipped", "retired", "pass"];

const CMD: Record<CommandClassification, string> = {
  pass: "✅ passes",
  broken: "❌ broken by this change",
  "failing-at-baseline": "⚠️ already failing at the baseline",
  fixed: "✅ fixed",
  undecided: "⚠️ not decided",
};

const COVERAGE: Record<CoverageStatus, string> = {
  complete: "✅ complete",
  partial: "◐ partial",
  "not-applicable": "— not applicable",
  "not-configured": "○ not configured",
  unavailable: "⚠️ unavailable",
};

function where(f: Finding): string {
  const parts: string[] = [];
  if (f.subject.file) parts.push(`\`${f.subject.file}${f.subject.line ? `:${f.subject.line}` : ""}\``);
  if (f.subject.operation && !f.subject.operation.startsWith(f.id.split(":").slice(1).join(":"))) parts.push(`\`${cell(f.subject.operation)}\``);
  return parts.join(" ") || "—";
}

function fence(s: string): string {
  return "```\n" + s.replace(/```/g, "ˋˋˋ").slice(0, 3000) + "\n```";
}

export function renderSuiteMarkdown(r: SuiteReport, opts: { title?: string; maxDetails?: number } = {}): string {
  const icon = r.exitCode === 0 ? "✅" : r.exitCode === 1 ? "❌" : "⚠️";
  const out: string[] = [];
  out.push(`## ${opts.title ?? "Crashpad check"}`, "");
  out.push(`${icon} **Crashpad: ${r.headline}** (exit ${r.exitCode})`, "");
  const pc = r.projectCommands;
  if (pc && (pc.results.length || pc.missing.length)) out.push(`Project commands (the project's own build/typecheck/test scripts, reported separately; they are not Crashpad checks): ${pc.headline}.`, "");
  const baseRef = /^[0-9a-f]{40}$/.test(r.base.ref) ? `\`${r.base.commit.slice(0, 12)}\`` : `\`${r.base.ref}\` (${r.base.commit.slice(0, 12)})`;
  out.push(`Baseline ${baseRef} → candidate ${r.candidate.label}${r.candidate.commit ? ` (${r.candidate.commit.slice(0, 12)})` : ""}. Configuration: ${r.configSources.length ? r.configSources.join(" + ") : "none"}.`, "");
  if (r.problems.length) {
    out.push("### Could not complete", "");
    for (const p of r.problems) out.push(`- **${p.kind}**: ${p.message}`);
    out.push("");
  }
  out.push("### Coverage", "", "| Area | Status | What ran | Not covered |", "|---|---|---|---|");
  // One line per item: command output belongs in the details, not in a table cell.
  const firstLine = (xs: string[]) => xs.map((x) => x.split("\n")[0]!.trim());
  for (const c of r.coverage) out.push(`| ${AREA_TITLES[c.area]} | ${COVERAGE[c.status]} | ${cell(firstLine(c.ran).join("; ")) || "—"} | ${cell(firstLine(c.missing).join("; ")) || "—"} |`);
  out.push("");
  if (!r.complete) out.push("_Coverage is partial: areas marked partial, not configured, or unavailable were not fully verified. They are not counted as passing._", "");
  if (pc && (pc.results.length || pc.missing.length)) {
    out.push("### Project commands", "", "_The project's own scripts, run on both versions. A result here is about the build or the tests; it does not show database, API, permission, or workflow behavior._", "");
    if (pc.results.length) {
      out.push("| Command | Result | Baseline | Candidate |", "|---|---|---|---|");
      for (const c of pc.results) out.push(`| \`${cell(c.command)}\` (${c.role}) | ${CMD[c.classification]} | ${cell(c.baseline.summary)} | ${cell(c.candidate.summary)} |`);
      out.push("");
      for (const c of pc.results.filter((x) => x.classification !== "pass" && x.classification !== "fixed")) {
        out.push(`**\`${cell(c.command)}\`**: ${c.message}`, "");
        for (const [side, o] of [["candidate", c.candidate], ["baseline", c.baseline]] as const) if (o.output) out.push(`<details><summary>${side}: output (last lines)</summary>`, "", fence(o.output), "</details>", "");
      }
    }
    for (const m of pc.missing) out.push(`- not run: ${m}`);
    if (pc.missing.length) out.push("");
  }
  const sorted = [...r.findings].sort((a, b) => ORDER.indexOf(a.classification) - ORDER.indexOf(b.classification));
  const notPass = sorted.filter((f) => f.classification !== "pass");
  if (notPass.length) {
    out.push("### Findings", "", "| Area | Check | Result | Baseline | Candidate | Where |", "|---|---|---|---|---|---|");
    for (const f of notPass) out.push(`| ${AREA_TITLES[f.area]} | \`${cell(f.id)}\` | ${LABEL[f.classification]} | ${cell(f.baseline.summary)} | ${cell(f.candidate.summary)} | ${where(f)} |`);
    out.push("");
    out.push("### Details", "");
    const max = opts.maxDetails ?? 25;
    for (const f of notPass.slice(0, max)) {
      out.push(`#### ${LABEL[f.classification].split(" ")[0]} \`${f.id}\`: ${cell(f.title)}`, "");
      out.push(f.message, "");
      for (const e of f.evidence.slice(0, 8)) out.push(`<details><summary>${e.side ? `${e.side}: ` : ""}${cell(e.label)}</summary>`, "", fence(e.detail), "</details>", "");
      if (f.reproduce) out.push(`Reproduce: ${f.reproduce}`, "");
    }
    if (notPass.length > max) out.push(`…and ${notPass.length - max} more; see the JSON report.`, "");
  }
  const passing = sorted.filter((f) => f.classification === "pass");
  if (passing.length) {
    out.push(`<details><summary>${passing.length} passing check(s)</summary>`, "", "| Area | Check | Candidate |", "|---|---|---|");
    for (const f of passing) out.push(`| ${AREA_TITLES[f.area]} | \`${cell(f.id)}\` | ${cell(f.candidate.summary)} |`);
    out.push("", "</details>", "");
  }
  out.push(`<sub>crashpad ${r.tool.version} · ${r.schemaVersion} · ${Math.round(r.durationMs / 100) / 10}s</sub>`, "");
  return out.join("\n");
}
