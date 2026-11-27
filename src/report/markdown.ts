import type { CheckFinding, Classification, Report, SideOutcome } from "./types.ts";

export const COMMENT_MARKER = "<!-- crashpad-report -->";

const LABEL: Record<Classification, string> = {
  pass: "✅ pass",
  regression: "❌ regression",
  "changed-result": "❌ changed result",
  "failed-assertion": "❌ failed assertion",
  "baseline-failure": "⚠️ existing baseline failure",
  "invalid-fixture": "⚠️ invalid fixture",
  inconclusive: "⚠️ inconclusive",
  skipped: "⏭️ skipped",
  removed: "❌ removed (needs review)",
  retired: "ℹ️ retired",
};

const ORDER: Classification[] = [
  "regression",
  "changed-result",
  "failed-assertion",
  "removed",
  "baseline-failure",
  "invalid-fixture",
  "inconclusive",
  "skipped",
  "retired",
  "pass",
];

export function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function side(o: SideOutcome): string {
  switch (o.status) {
    case "ok":
      if (o.assertion !== undefined) return o.assertion === null ? "invalid result" : o.assertion ? "true" : "false";
      if (o.affectedRows !== undefined) return `ok, ${o.affectedRows} row(s) affected`;
      return `ok, ${o.rowCount} row(s)${o.truncated ? " (limit exceeded)" : ""}`;
    case "error":
      return `error ${o.error?.code ?? ""}`.trim();
    case "invalid":
      return "invalid";
    case "not-present":
      return "—";
    case "not-run":
      return "not run";
  }
}

function where(c: CheckFinding): string {
  const s = c.source ?? c.baselineSource;
  if (!s) return "";
  return s.kind === "file" ? `\`${s.path}:${s.line}\`` : `inline in \`${s.path}\``;
}

export function statusLine(r: Report): string {
  const icon = r.exitCode === 0 ? "✅" : r.exitCode === 1 ? "❌" : "⚠️";
  return `${icon} **Crashpad: ${r.headline}** (exit ${r.exitCode})`;
}

function findingDetail(c: CheckFinding): string {
  const lines: string[] = [];
  lines.push(`#### \`${c.id}\` — ${LABEL[c.classification]}`);
  lines.push("");
  lines.push(`- Category: ${c.category}${c.isNew ? " (new check)" : ""}${c.fixtureChanged ? " (fixture changed in this change)" : ""}`);
  if (c.description) lines.push(`- Purpose: ${c.description}`);
  const loc = where(c);
  if (loc) lines.push(`- Source: ${loc}`);
  lines.push(`- Baseline: ${side(c.baseline)}`);
  lines.push(`- Candidate: ${side(c.candidate)}`);
  lines.push(`- Finding: ${c.message}`);
  for (const [label, o] of [["Baseline", c.baseline], ["Candidate", c.candidate]] as const) {
    if (o.error) {
      const at = o.error.at ? ` at \`${o.error.at.path}:${o.error.at.line}:${o.error.at.column}\`` : "";
      lines.push(`- ${label} PostgreSQL error${at}: \`${o.error.code ?? "?"}\` ${o.error.message}`);
    }
  }
  if (c.columnDiff) {
    lines.push("");
    lines.push("| # | baseline column | candidate column |");
    lines.push("|---|---|---|");
    const n = Math.max(c.columnDiff.baseline.length, c.columnDiff.candidate.length);
    for (let i = 0; i < n; i++) {
      const b = c.columnDiff.baseline[i];
      const k = c.columnDiff.candidate[i];
      lines.push(`| ${i + 1} | ${b ? cell(`${b.name} ${b.type}`) : "—"} | ${k ? cell(`${k.name} ${k.type}`) : "—"} |`);
    }
  }
  if (c.rowDiff) {
    lines.push(`- Rows: baseline ${c.rowDiff.baselineRowCount}, candidate ${c.rowDiff.candidateRowCount}; ${c.rowDiff.missingCount} missing, ${c.rowDiff.extraCount} unexpected`);
    if (c.rowDiff.samples) {
      for (const r of c.rowDiff.samples.missing) lines.push(`  - missing: \`${cell(JSON.stringify(r))}\``);
      for (const r of c.rowDiff.samples.extra) lines.push(`  - unexpected: \`${cell(JSON.stringify(r))}\``);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderMarkdown(r: Report, opts: { title?: string; maxDetails?: number } = {}): string {
  const out: string[] = [];
  out.push(`## ${opts.title ?? "Crashpad database check"}`);
  out.push("");
  out.push(statusLine(r));
  out.push("");
  out.push(`Baseline \`${r.base.ref}\` (${r.base.commit.slice(0, 12)}) → candidate ${r.candidate.label}${r.candidate.commit ? ` (${r.candidate.commit.slice(0, 12)})` : ""} · project \`${r.project}\``);
  out.push("");

  if (r.problems.length) {
    out.push("### Could not complete");
    for (const p of r.problems) out.push(`- **${p.kind}**: ${p.message}`);
    out.push("");
  }

  if (r.migrations.new.length || r.migrations.baseline.length) {
    out.push("### Migrations");
    out.push(`- ${r.migrations.baseline.length} baseline migration(s) applied to both databases`);
    for (const m of r.migrations.new) {
      const icon = m.status === "applied" ? "✅" : m.status === "failed" ? "❌" : "⏭️";
      const err = m.error ? ` — \`${m.error.code ?? "?"}\` ${m.error.message}${m.error.at ? ` at \`${m.error.at.path}:${m.error.at.line}\`` : ""}` : "";
      out.push(`- ${icon} new: \`${m.file}\` ${m.status}${err}`);
    }
    if (!r.migrations.new.length) out.push("- no new migrations (query/code-only change)");
    out.push("");
  }

  if (r.history.length) {
    out.push("### Migration history and baseline inputs");
    for (const h of r.history) out.push(`- ${h.blocking ? "⚠️" : "ℹ️"} \`${h.file}\`: ${h.message}`);
    out.push("");
  }

  if (r.checks.length) {
    const sorted = [...r.checks].sort((a, b) => ORDER.indexOf(a.classification) - ORDER.indexOf(b.classification));
    out.push("### Checks");
    out.push("");
    out.push("| Check | Category | Result | Baseline | Candidate | Source |");
    out.push("|---|---|---|---|---|---|");
    for (const c of sorted) {
      const err = c.candidate.error?.code ? ` \`${c.candidate.error.code}\`` : "";
      out.push(`| \`${c.id}\`${c.isNew ? " 🆕" : ""} | ${c.category} | ${LABEL[c.classification]} | ${cell(side(c.baseline))} | ${cell(side(c.candidate))}${err} | ${where(c)} |`);
    }
    out.push("");
    const notable = sorted.filter((c) => c.classification !== "pass");
    const max = opts.maxDetails ?? 50;
    if (notable.length) {
      out.push("### Details");
      out.push("");
      for (const c of notable.slice(0, max)) out.push(findingDetail(c));
      if (notable.length > max) out.push(`…and ${notable.length - max} more; see the JSON report.`);
    }
  }
  const s = r.summary;
  out.push(
    `<sub>${s.total} checks · ${s.pass} pass · ${s.regression + s["changed-result"] + s["failed-assertion"] + s.removed} broken · ${s["baseline-failure"] + s["invalid-fixture"] + s.inconclusive + s.skipped} undecided · PostgreSQL ${r.database.serverVersionNum ?? "?"} · crashpad ${r.tool.version} · ${r.durationMs} ms</sub>`,
  );
  return out.join("\n") + "\n";
}
