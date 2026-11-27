import { GitHubHttpError, type GitHubApi, type IssueComment } from "../../src/github/client.ts";

/** A FAKE of the GitHub REST API subset Crashpad uses. Git operations in tests stay real. */
export class FakeGitHub implements GitHubApi {
  prs: Array<{ owner: string; repo: string; title: string; body: string; head: string; base: string; draft: boolean }> = [];
  comments: IssueComment[] = [];
  failCreatePr = false;
  async createPullRequest(owner: string, repo: string, p: { title: string; body: string; head: string; base: string; draft: boolean }) {
    if (this.failCreatePr) throw new GitHubHttpError(422, "Validation Failed: simulated");
    this.prs.push({ owner, repo, ...p });
    return { number: this.prs.length, html_url: `https://github.com/${owner}/${repo}/pull/${this.prs.length}` };
  }
  async listIssueComments() {
    return this.comments;
  }
  async createIssueComment(_o: string, _r: string, _i: number, body: string) {
    const c = { id: this.comments.length + 1, body, html_url: `https://example.test/c/${this.comments.length + 1}` };
    this.comments.push(c);
    return c;
  }
  async updateIssueComment(_o: string, _r: string, id: number, body: string) {
    const c = this.comments.find((x) => x.id === id)!;
    c.body = body;
    return c;
  }
}
