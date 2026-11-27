import { cell } from "../report/markdown.ts";
import type { RepairResult } from "./loop.ts";

export const REPAIR_TRAILER = "Crashpad-Repair";

export function repairTitle(r: RepairResult, branch: string): string {
  const n = r.original.findings.filter((f) => ["regression", "changed-result", "failed-assertion", "removed"].includes(f.classification)).length;
  return `Crashpad: repair ${n} failing check(s) on ${branch}`;
}

export function repairBody(r: RepairResult, opts: { branch: string; repairId: string }): string {
  const who = r.proposer === "rename-fixer" ? "Crashpad's deterministic rename fixer (no AI model involved)" : r.proposer === "claude-code" ? "Claude Code, running on the repository owner's machine with their own sign-in" : (r.proposer ?? "unknown");
  const out: string[] = [];
  out.push(`> Draft PR opened by **Crashpad**. The change was proposed by ${who} and then **verified independently by Crashpad**. Please review before merging.`, "");
  out.push("### What was failing", "");
  out.push(`On \`${opts.branch}\` (${r.original.candidate.commit?.slice(0, 12)}), compared with \`${r.original.base.ref}\` (${r.original.base.commit.slice(0, 12)}): **${r.original.headline}**.`, "");
  out.push("### Verification", "");
  out.push(
    "Crashpad re-ran every applicable check on the patched code. Expectations (check manifests, assertions, contracts, configuration) came from the **original** commit, not from the patch, and the baseline is unchanged. The proposer's own report of success was not used as evidence.",
    "",
  );
  if (r.verification) {
    out.push(`Result: **${r.verification.headline}** (exit ${r.verification.exitCode}).`, "");
    out.push("| Check | Before | After |", "|---|---|---|");
    const after = new Map(r.verification.findings.map((f) => [f.id, f]));
    for (const f of r.original.findings.filter((x) => x.classification !== "pass")) out.push(`| \`${cell(f.id)}\` | ${f.classification} | ${after.get(f.id)?.classification ?? "—"} |`);
    out.push("");
  }
  const last = r.attempts.at(-1);
  if (last?.tests?.results.length) {
    out.push("Application tests:", "");
    for (const t of last.tests.results) out.push(`- \`${t.command}\`: ${t.ok ? "passed" : r.preexistingTestFailures.includes(t.command) ? "failed (already failing before this change; not counted)" : "failed"}`);
    out.push("");
  }
  out.push("### Attempts", "", "| # | Proposer | Files | Verdict | Notes |", "|---|---|---|---|---|");
  for (const a of r.attempts) out.push(`| ${a.attempt} | ${a.proposer} | ${a.changedFiles.length} | ${a.verdict} | ${cell(a.reason).slice(0, 200)}${a.agent?.turns !== undefined ? ` (${a.agent.turns} turns)` : ""} |`);
  out.push("", "<details><summary>Patch</summary>", "", "```diff", r.patch.trimEnd().slice(0, 50_000), "```", "</details>", "");
  out.push(`<sub>${REPAIR_TRAILER}: ${opts.repairId}</sub>`);
  return out.join("\n") + "\n";
}
