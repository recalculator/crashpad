import fs from "node:fs/promises";
import path from "node:path";
import { UsageError, writeReport, type Values } from "../cli.ts";
import { resolveContext } from "../context.ts";
import { proposeAndVerify, type FixResult } from "../fix/pipeline.ts";
import { renderMarkdown } from "../report/markdown.ts";
import { sha256 } from "../fix/patch.ts";

export async function writeFixArtifacts(dir: string, r: FixResult): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeReport(dir, r.original, renderMarkdown(r.original, { title: "Crashpad: original findings" }), "original-report");
  if (r.verification) {
    await writeReport(dir, r.verification, renderMarkdown(r.verification, { title: "Crashpad: verification with proposed patch" }), "verification-report");
  }
  await fs.writeFile(path.join(dir, "fix-plan.json"), JSON.stringify(r.plan, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "fix.patch"), r.patch);
  await fs.writeFile(path.join(dir, "pr-description.md"), `# ${r.prTitle}\n\n${r.prBody}`);
}

export function fixSummary(r: FixResult, outDir: string): string {
  const lines = [`Crashpad fix: ${r.outcome.toUpperCase()} (exit ${r.exitCode})`, `  original:     ${r.original.headline}`];
  if (r.verification) lines.push(`  verification: ${r.verification.headline}`);
  for (const e of r.plan.edits) lines.push(`  edit: ${e.path} (${e.changes.length} change(s))`);
  for (const x of r.plan.refusals) lines.push(`  not changed: ${x.path ?? ""}${x.path ? ": " : ""}${x.reason}`);
  for (const n of r.plan.notes) lines.push(`  note: ${n}`);
  lines.push(`  artifacts: ${outDir}`);
  return lines.join("\n") + "\n";
}

export async function cmdFix(v: Values, cwd: string): Promise<number> {
  if (!v.base) throw new UsageError("--base is required");
  const ctx = await resolveContext({ cwd, base: v.base, head: v.head, project: v.project, databaseUrl: v["database-url"] });
  const log = v.verbose ? (m: string) => process.stderr.write(`crashpad: ${m}\n`) : undefined;
  const result = await proposeAndVerify({ ...ctx.input, keepDatabases: !!v["keep-databases"] }, log ? { log } : {});
  const outDir = path.resolve(cwd, v.out ?? "crashpad-fix");
  await writeFixArtifacts(outDir, result);
  process.stdout.write(fixSummary(result, outDir));

  if (v.apply) {
    if (result.outcome !== "verified") {
      process.stderr.write(`crashpad: not applying: outcome is ${result.outcome}; only verified patches are applied\n`);
      return result.exitCode || 1;
    }
    if (!ctx.workingTree) {
      process.stderr.write("crashpad: --apply only works when the candidate is the working tree (no --head)\n");
      return 2;
    }
    for (const e of result.proposal!.edits) {
      const abs = path.join(ctx.repoRoot, e.path);
      const current = await fs.readFile(abs, "utf8");
      if (sha256(current) !== sha256(e.before)) {
        process.stderr.write(`crashpad: not applying: ${e.path} changed after verification\n`);
        return 2;
      }
    }
    for (const e of result.proposal!.edits) await fs.writeFile(path.join(ctx.repoRoot, e.path), e.after);
    process.stdout.write(`applied verified patch to ${result.proposal!.edits.length} file(s) in the working tree\n`);
  }
  return result.exitCode;
}
