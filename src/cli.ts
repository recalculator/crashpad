import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { databaseUrl, resolveContext, suiteInputFrom } from "./context.ts";
import { renderSuiteMarkdown } from "./suite/markdown.ts";
import { runSuite } from "./suite/runner.ts";
import { VERSION } from "./version.ts";
import { RefError } from "./git.ts";

const HELP = `crashpad ${VERSION} — check whether a backend change breaks database, API, configuration,
permission, or workflow behavior, and repair it with independent verification

Usage:
  crashpad check   --base <ref> [--head <ref>] [--project <dir>] [--report-dir <dir>] [--format md|json] [--no-discovery]
  crashpad repair  --base <ref> [--head <ref> | --branch <b>] [--agent claude|none] [--max-attempts 3] [--max-turns 40]
                   [--max-budget-usd <n>] [--deadline-min 30] [--attempt-timeout-min 10] [--claude-auth subscription|existing]
                   [--model <m>] [--no-deterministic] [--out <dir>] [--apply] [--publish --repo <owner/name> [--dry-run]]
  crashpad fix     --base <ref> [--head <ref>] [--project <dir>] [--out <dir>] [--apply]     (database rename fixer only)
  crashpad setup   [--repo-dir <path>...]          check prerequisites, Claude Code, GitHub connection; discover repositories
  crashpad discover [--project <dir>]               show what Crashpad found in this repository and what is missing
  crashpad settings [--set key=value] [--unset key] per-repository settings stored in Crashpad's storage (not the repo)
  crashpad connect --service <url> [--name <n>]     pair this computer with the Crashpad GitHub App (GitHub device flow)
  crashpad companion [status] [--once] [--enable-repair|--disable-repair]   run the local companion
  crashpad policy  --repo <owner/name> [--auto-repair on|off] [--max-repairs <n>]
  crashpad service [manifest --url <public url>]    run the GitHub App service (or print its App manifest)
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
  "no-discovery": { type: "boolean" },
  agent: { type: "string" },
  "claude-auth": { type: "string" },
  model: { type: "string" },
  "max-attempts": { type: "string" },
  "max-turns": { type: "string" },
  "max-budget-usd": { type: "string" },
  "deadline-min": { type: "string" },
  "attempt-timeout-min": { type: "string" },
  "no-deterministic": { type: "boolean" },
  publish: { type: "boolean" },
  set: { type: "string", multiple: true },
  unset: { type: "string", multiple: true },
  service: { type: "string" },
  "repo-dir": { type: "string", multiple: true },
  name: { type: "string" },
  url: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  once: { type: "boolean" },
  "enable-repair": { type: "boolean" },
  "disable-repair": { type: "boolean" },
  "auto-repair": { type: "string" },
  "max-repairs": { type: "string" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

export class UsageError extends Error {
  override name = "UsageError";
}

export type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"] & { _sub?: string };

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
  const { discoverer, settingsFor } = await import("./discovery/index.ts");
  const settings = v["no-discovery"] ? undefined : await settingsFor(ctx.repoRoot);
  const { report } = await runSuite({
    ...suiteInputFrom(ctx, databaseUrl(v["database-url"])),
    discover: v["no-discovery"] ? false : discoverer(),
    ...(settings ? { settings } : {}),
    keepResources: !!v["keep-databases"],
    ...(log ? { log } : {}),
  });
  const md = renderSuiteMarkdown(report);
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
  const { positionals } = parsed;
  const values: Values = { ...parsed.values, ...(positionals[1] ? { _sub: positionals[1] } : {}) };
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
      case "repair":
        return await (await import("./commands/repair.ts")).cmdRepair(values, cwd);
      case "service":
        return await (await import("./commands/companion.ts")).cmdService(values);
      case "connect":
        return await (await import("./commands/companion.ts")).cmdConnect(values);
      case "companion":
        return await (await import("./commands/companion.ts")).cmdCompanion(values);
      case "policy":
        return await (await import("./commands/companion.ts")).cmdPolicy(values);
      case "discover":
        return await (await import("./commands/setup.ts")).cmdDiscover(values, cwd);
      case "settings":
        return await (await import("./commands/setup.ts")).cmdSettings(values, cwd);
      case "setup":
        return await (await import("./commands/setup.ts")).cmdSetup(values, cwd);
      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`crashpad: ${err.message}\n\n${HELP}`);
      return 2;
    }
    if (err instanceof RefError) {
      process.stderr.write(`crashpad: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`crashpad: ${(err as Error).stack ?? String(err)}\n`);
    return 2;
  }
}
