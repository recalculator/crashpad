import fs from "node:fs/promises";
import path from "node:path";
import { UsageError, type Values } from "../cli.ts";
import { databaseUrl, projectDirFor } from "../context.ts";
import { PgServer } from "../db/postgres.ts";
import type { FixPlan } from "../fix/pipeline.ts";
import { repoRoot } from "../git.ts";
import { FetchGitHubApi, parseRepo, resolveToken, type GitHubApi } from "../github/client.ts";
import { publishFixPr, type PublishResult } from "../github/publish.ts";
import { writeFixArtifacts } from "./fix.ts";

export async function cmdFixPr(v: Values, cwd: string, api?: GitHubApi | null): Promise<number> {
  if (!v.repo || !v.branch || !v.base) throw new UsageError("--repo, --branch and --base are required");
  parseRepo(v.repo);
  const root = await repoRoot(cwd);
  const projectDir = projectDirFor(root, cwd, v.project);
  const plan = v.plan ? (JSON.parse(await fs.readFile(path.resolve(cwd, v.plan), "utf8")) as FixPlan) : undefined;
  let client: GitHubApi | null = api ?? null;
  if (api === undefined && !v["dry-run"]) {
    const token = await resolveToken();
    client = token ? new FetchGitHubApi(token) : null;
  }
  const log = (m: string) => process.stderr.write(`crashpad: ${m}\n`);
  const result: PublishResult = await publishFixPr({
    repoRoot: root,
    projectDir,
    repo: v.repo,
    branch: v.branch,
    base: v.base,
    ...(v.remote ? { remote: v.remote } : {}),
    ...(plan ? { plan } : {}),
    dryRun: !!v["dry-run"],
    server: new PgServer(databaseUrl(v["database-url"])),
    api: client,
    log,
  });
  const outDir = path.resolve(cwd, v.out ?? "crashpad-fix-pr");
  if (result.fix) await writeFixArtifacts(outDir, result.fix);
  await fs.mkdir(outDir, { recursive: true });
  const { fix: _fix, ...summary } = result;
  await fs.writeFile(path.join(outDir, "publish-result.json"), JSON.stringify(summary, null, 2) + "\n");

  const lines = [`Crashpad fix-pr: ${result.status.toUpperCase()} — ${result.message}`];
  if (result.prUrl) lines.push(`  draft PR: ${result.prUrl}`);
  if (result.branch) lines.push(`  branch:   ${result.branch}`);
  if (result.recovery) lines.push(`  recover with (from ${outDir}):`, `    ${result.recovery}`);
  lines.push(`  artifacts: ${outDir}`);
  process.stdout.write(lines.join("\n") + "\n");
  return result.exitCode;
}
