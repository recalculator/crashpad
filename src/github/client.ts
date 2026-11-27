import { execFile } from "node:child_process";

export interface IssueComment {
  id: number;
  body: string;
  html_url?: string;
}

/** The subset of the GitHub REST API Crashpad uses. Tests substitute a fake. */
export interface GitHubApi {
  createPullRequest(owner: string, repo: string, p: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<{ number: number; html_url: string }>;
  listIssueComments(owner: string, repo: string, issue: number): Promise<IssueComment[]>;
  createIssueComment(owner: string, repo: string, issue: number, body: string): Promise<IssueComment>;
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<IssueComment>;
}

export class GitHubHttpError extends Error {
  override name = "GitHubHttpError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class FetchGitHubApi implements GitHubApi {
  private token: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  constructor(token: string, baseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com", fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "crashpad",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        const j = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string }> };
        msg = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join("; ");
      } catch {
        /* keep raw text */
      }
      throw new GitHubHttpError(res.status, `GitHub API ${method} ${path} failed (${res.status}): ${msg}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  createPullRequest(owner: string, repo: string, p: { title: string; body: string; head: string; base: string; draft: boolean }) {
    return this.request<{ number: number; html_url: string }>("POST", `/repos/${owner}/${repo}/pulls`, p);
  }

  async listIssueComments(owner: string, repo: string, issue: number): Promise<IssueComment[]> {
    const all: IssueComment[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.request<IssueComment[]>("GET", `/repos/${owner}/${repo}/issues/${issue}/comments?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  createIssueComment(owner: string, repo: string, issue: number, body: string) {
    return this.request<IssueComment>("POST", `/repos/${owner}/${repo}/issues/${issue}/comments`, { body });
  }

  updateIssueComment(owner: string, repo: string, commentId: number, body: string) {
    return this.request<IssueComment>("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
  }
}

/** GITHUB_TOKEN / GH_TOKEN, falling back to the GitHub CLI's stored login for local use. */
export async function resolveToken(): Promise<string | null> {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout.toString().trim() || null));
  });
}

export function parseRepo(full: string): { owner: string; repo: string } {
  const m = full.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) throw new Error(`--repo must look like owner/name (got ${JSON.stringify(full)})`);
  return { owner: m[1]!, repo: m[2]! };
}
