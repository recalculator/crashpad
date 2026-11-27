import { pgErrorName } from "../db/errors.ts";
import { cell } from "../report/markdown.ts";
import type { CheckFinding, Report } from "../report/types.ts";
import type { FixPlan } from "./pipeline.ts";

export function prTitle(plan: FixPlan): string {
  const r = plan.renames;
  if (r.length === 1) return `Crashpad: update SQL for renamed column ${r[0]!.table}.${r[0]!.from} → ${r[0]!.to}`;
  if (r.length > 1) return `Crashpad: update SQL for ${r.length} renamed columns`;
  return "Crashpad: proposed SQL fix";
}

function short(c: CheckFinding | undefined): string {
  if (!c) return "—";
  if (c.candidate.error?.code) return `${c.classification} (\`${c.candidate.error.code}\` ${pgErrorName(c.candidate.error.code)})`;
  return c.classification;
}

export function renderPrBody(plan: FixPlan, original: Report, verification: Report | null, patch: string): string {
  const out: string[] = [];
  out.push(`> Draft PR opened by **Crashpad** using its deterministic, rules-based rename fixer (${plan.proposer.name}). No AI model was involved. Please review before merging.`);
  out.push("");
  out.push("### Why");
  out.push("");
  for (const r of plan.renames) out.push(`- \`${r.migration}\` renames \`${r.schema}.${r.table}.${r.from}\` → \`${r.to}\`.`);
  out.push(`- On the original change, Crashpad reported: **${original.headline}** (exit ${original.exitCode}).`);
  out.push("");
  out.push("### What changed");
  out.push("");
  for (const e of plan.edits) {
    out.push(`- \`${e.path}\` (checks: ${e.checkIds.map((i) => `\`${i}\``).join(", ")})`);
    for (const c of e.changes) {
      const desc = c.kind === "output-alias" ? `added \`${c.after.trim()}\` to keep the response field name` : `\`${cell(c.before)}\` → \`${cell(c.after)}\` (${c.kind})`;
      out.push(`  - line ${c.line}: ${desc}`);
    }
  }
  out.push("");
  out.push("### Verification");
  out.push("");
  out.push(
    `Crashpad re-ran **every** configured check. The baseline side ran the **original** queries from ${/^[0-9a-f]{40}$/.test(plan.base.ref) ? `\`${plan.base.commit.slice(0, 12)}\`` : `\`${plan.base.ref}\` (${plan.base.commit.slice(0, 12)})`} on the baseline database; the candidate side ran the **patched** queries on the migrated database. Output columns, rows, affected-row counts, and assertions were compared against that original baseline contract.`,
  );
  out.push("");
  if (verification) {
    out.push(`Result: **${verification.headline}** (exit ${verification.exitCode}).`);
    out.push("");
    out.push("| Check | Before fix | After fix |");
    out.push("|---|---|---|");
    const before = new Map(original.checks.map((c) => [c.id, c]));
    for (const c of verification.checks) out.push(`| \`${c.id}\` | ${short(before.get(c.id))} | ${short(c)} |`);
  } else {
    out.push("Not verified.");
  }
  out.push("");
  if (plan.refusals.length) {
    out.push("### Not changed");
    for (const r of plan.refusals) out.push(`- ${r.path ? `\`${r.path}\`: ` : ""}${r.reason}`);
    out.push("");
  }
  out.push("<details><summary>Patch</summary>");
  out.push("");
  out.push("```diff");
  out.push(patch.trimEnd());
  out.push("```");
  out.push("</details>");
  out.push("");
  out.push(`<sub>Fix plan ${plan.schemaVersion} · inputs digest \`${plan.inputsDigest.slice(0, 16)}\` · crashpad ${plan.tool.version}</sub>`);
  return out.join("\n") + "\n";
}
