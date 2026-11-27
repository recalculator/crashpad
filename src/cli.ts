import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveContext } from "./context.ts";
import { runChecks } from "./runner.ts";
import { renderMarkdown } from "./report/markdown.ts";
import { VERSION } from "./version.ts";

const HELP = `crashpad ${VERSION} — check whether a change breaks your app's PostgreSQL behavior

Usage:
  crashpad check   --base <ref> [--head <ref>] [--project <dir>] [--report-dir <dir>] [--format md|json]
  crashpad fix     --base <ref> [--head <ref>] [--project <dir>] [--out <dir>] [--apply]
  crashpad fix-pr  --repo <owner/name> --branch <target-branch> --base <ref> [--project <dir>] [--plan <fix-plan.json>] [--remote origin] [--dry-run]
  crashpad comment --report <report.json> --repo <owner/name> --pr <number>
  crashpad validate [--project <dir>]

Common options:
  --database-url <url>   PostgreSQL server used to create throwaway databases
                         (default: $CRASHPAD_DATABASE_URL, $DATABASE_URL, or postgres://localhost:5432/postgres)
  --keep-databases       Do not drop the baseline/candidate databases after the run
  --verbose              Log progress to stderr

Exit codes:
  0  all configured checks pass
  1  actionable regression, changed result, failed assertion, removed check, or failed migration
  2  invalid configuration, baseline problem, infrastructure failure, incomplete or inconclusive run
`;

export const OPTIONS = {
  base: { type: "string" },
  head: { type: "string" },
  project: { type: "string" },
  "report-dir": { type: "string" },
  format: { type: "string" },
  out: { type: "string" },
  apply: { type: "boolean" },
  repo: { type: "string" },
  branch: { type: "string" },
  plan: { type: "string" },
  remote: { type: "string" },
  "dry-run": { type: "boolean" },
  report: { type: "string" },
  pr: { type: "string" },
  "database-url": { type: "string" },
  "keep-databases": { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

export class UsageError extends Error {
  override name = "UsageError";
}

export type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function need(v: Values, key: keyof Values): string {
  const x = v[key];
  if (typeof x !== "string" || !x) throw new UsageError(`--${String(key)} is required`);
  return x;
}

export async function writeReport(dir: string, report: object, markdown: string, basename = "crashpad-report"): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${basename}.json`), JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(path.join(dir, `${basename}.md`), markdown);
}

async function cmdCheck(v: Values, cwd: string): Promise<number> {
  const ctx = await resolveContext({ cwd, base: need(v, "base"), head: v.head, project: v.project, databaseUrl: v["database-url"] });
  const log = v.verbose ? (m: string) => process.stderr.write(`crashpad: ${m}\n`) : undefined;
  const { report } = await runChecks({ ...ctx.input, keepDatabases: !!v["keep-databases"], ...(log ? { log } : {}) });
  const md = renderMarkdown(report);
  if (v["report-dir"]) await writeReport(path.resolve(cwd, v["report-dir"]), report, md);
  process.stdout.write(v.format === "json" ? JSON.stringify(report, null, 2) + "\n" : md);
  return report.exitCode;
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`crashpad: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const cmd = positionals[0];
  if (!cmd || values.help) {
    process.stdout.write(HELP);
    return cmd ? 0 : 2;
  }
  try {
    switch (cmd) {
      case "check":
        return await cmdCheck(values, cwd);
      case "fix":
        return await (await import("./commands/fix.ts")).cmdFix(values, cwd);
      case "fix-pr":
        return await (await import("./commands/fix-pr.ts")).cmdFixPr(values, cwd);
      case "comment":
        return await (await import("./commands/comment.ts")).cmdComment(values, cwd);
      case "validate":
        return await (await import("./commands/validate.ts")).cmdValidate(values, cwd);
      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`crashpad: ${err.message}\n\n${HELP}`);
      return 2;
    }
    process.stderr.write(`crashpad: ${(err as Error).stack ?? String(err)}\n`);
    return 2;
  }
}
