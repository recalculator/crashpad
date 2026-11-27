import fs from "node:fs/promises";
import path from "node:path";
import { UsageError, type Values } from "../cli.ts";
import { FetchGitHubApi, GitHubHttpError, parseRepo, resolveToken, type GitHubApi } from "../github/client.ts";
import { COMMENT_MARKER, renderMarkdown } from "../report/markdown.ts";
import { REPORT_SCHEMA, type Report } from "../report/types.ts";
import { renderSuiteMarkdown } from "../suite/markdown.ts";
import { SUITE_REPORT_SCHEMA, type SuiteReport } from "../suite/types.ts";

const MAX_COMMENT = 60_000;

export function commentBody(report: Report | SuiteReport, runUrl?: string): string {
  let md = report.schemaVersion === SUITE_REPORT_SCHEMA ? renderSuiteMarkdown(report as SuiteReport, { maxDetails: 8 }) : renderMarkdown(report as Report, { title: "Crashpad database check", maxDetails: 8 });
  const footer = runUrl ? `\n[Full report and artifacts](${runUrl})\n` : "";
  if (md.length + footer.length > MAX_COMMENT) md = md.slice(0, MAX_COMMENT - footer.length - 200) + "\n\n…truncated; see the full report artifact.\n";
  return `${COMMENT_MARKER}\n${md}${footer}`;
}

/** Create the Crashpad comment, or update the existing one (identified by a hidden marker). */
export async function upsertComment(api: GitHubApi, owner: string, repo: string, pr: number, body: string): Promise<{ action: "created" | "updated"; url?: string }> {
  const existing = (await api.listIssueComments(owner, repo, pr)).find((c) => c.body?.includes(COMMENT_MARKER));
  if (existing) {
    const c = await api.updateIssueComment(owner, repo, existing.id, body);
    return { action: "updated", ...(c.html_url ? { url: c.html_url } : {}) };
  }
  const c = await api.createIssueComment(owner, repo, pr, body);
  return { action: "created", ...(c.html_url ? { url: c.html_url } : {}) };
}

export async function cmdComment(v: Values, cwd: string, api?: GitHubApi): Promise<number> {
  if (!v.report || !v.repo || !v.pr) throw new UsageError("--report, --repo and --pr are required");
  const { owner, repo } = parseRepo(v.repo);
  const pr = Number(v.pr);
  if (!Number.isInteger(pr) || pr <= 0) throw new UsageError("--pr must be a pull request number");
  const report = JSON.parse(await fs.readFile(path.resolve(cwd, v.report), "utf8")) as Report | SuiteReport;
  const schema = (report as { schemaVersion: string }).schemaVersion;
  if (schema !== REPORT_SCHEMA && schema !== SUITE_REPORT_SCHEMA) throw new UsageError(`unsupported report schema ${schema}`);
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
  let client = api;
  if (!client) {
    const token = await resolveToken();
    if (!token) {
      process.stderr.write("crashpad: no GitHub token available; skipping PR comment (the job summary and artifacts still have the report)\n");
      return 0;
    }
    client = new FetchGitHubApi(token);
  }
  try {
    const r = await upsertComment(client, owner, repo, pr, commentBody(report, runUrl));
    process.stdout.write(`crashpad: ${r.action} PR comment${r.url ? ` ${r.url}` : ""}\n`);
    return 0;
  } catch (err) {
    if (err instanceof GitHubHttpError && (err.status === 403 || err.status === 404 || err.status === 401)) {
      // Expected for pull requests from forks: the token is read-only. The check result is unaffected.
      process.stderr.write(`crashpad: could not write PR comment (${err.status}, likely a read-only token on a fork PR); skipping\n`);
      return 0;
    }
    throw err;
  }
}
