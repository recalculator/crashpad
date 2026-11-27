import path from "node:path";
import { describe, expect, it } from "vitest";
import { cmdComment, commentBody, upsertComment } from "../../src/commands/comment.ts";
import type { GitHubApi, IssueComment } from "../../src/github/client.ts";
import { GitHubHttpError } from "../../src/github/client.ts";
import { fixBranchName, publishFixPr } from "../../src/github/publish.ts";
import { COMMENT_MARKER } from "../../src/report/markdown.ts";
import { check, g, projectFiles, server, tempDir, TestRepo, type CheckSpec } from "../helpers/project.ts";

/**
 * GitHub's HTTP API is faked here. Git is real: a local bare repository stands in
 * for the GitHub remote via `url.<path>.insteadOf`, so fetch/push run for real.
 */
class FakeGitHub implements GitHubApi {
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

const SCHEMA = "CREATE TABLE customers (id int PRIMARY KEY, name text NOT NULL);";
const CHECKS: CheckSpec[] = [
  { id: "names", category: "read", source: "sql/names.sql" },
  { id: "add", category: "write", source: "sql/add.sql", params: [9, "Zed"], expectRows: 1 },
];
const SQL = { "names.sql": "SELECT id, name FROM customers ORDER BY id\n", "add.sql": "INSERT INTO customers (id, name) VALUES ($1, $2)\n" };

function setup(branchFiles: Record<string, string | null> = { "db/migrations/001_rename.sql": "ALTER TABLE customers RENAME COLUMN name TO full_name;\n" }) {
  const bare = path.join(tempDir(), "remote.git");
  g(path.dirname(bare), "init", "-q", "--bare", "-b", "main", bare);
  const repo = TestRepo.create(projectFiles({ schema: SCHEMA, seed: "INSERT INTO customers VALUES (1, 'Ann');", checks: CHECKS, sql: SQL }));
  g(repo.dir, "remote", "add", "origin", "https://github.com/acme/shop.git");
  g(repo.dir, "config", `url.${bare}.insteadOf`, "https://github.com/acme/shop.git");
  g(repo.dir, "push", "-q", "origin", "main");
  g(repo.dir, "switch", "-q", "-c", "feature/rename");
  repo.write(branchFiles);
  repo.commit("rename customers.name");
  g(repo.dir, "push", "-q", "origin", "feature/rename");
  g(repo.dir, "switch", "-q", "main");
  // The user has unrelated uncommitted work in their checkout.
  repo.write({ "notes.txt": "work in progress\n", "sql/names.sql": SQL["names.sql"] + "-- local uncommitted edit\n" });
  return { repo, bare };
}

const opts = (repo: TestRepo, api: GitHubApi | null, extra: object = {}) => ({
  repoRoot: repo.dir,
  projectDir: ".",
  repo: "acme/shop",
  branch: "feature/rename",
  base: "origin/main",
  server,
  api,
  ...extra,
});

function snapshot(repo: TestRepo) {
  return {
    head: g(repo.dir, "rev-parse", "HEAD"),
    branch: g(repo.dir, "branch", "--show-current"),
    status: g(repo.dir, "status", "--porcelain"),
    worktrees: g(repo.dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length,
    localBranches: g(repo.dir, "branch", "--format=%(refname:short)"),
    names: repo.read("sql/names.sql"),
  };
}

describe("draft fix-PR publishing", () => {
  it("re-verifies, commits only the intended files in an isolated worktree, pushes without force, and opens a draft PR", async () => {
    const { repo, bare } = setup();
    const before = snapshot(repo);
    const api = new FakeGitHub();
    const res = await publishFixPr(opts(repo, api));
    expect(res.status).toBe("opened");
    expect(res.exitCode).toBe(0);

    const target = g(bare, "rev-parse", "feature/rename");
    const branch = fixBranchName("feature/rename", target);
    expect(res.branch).toBe(branch);
    expect(api.prs).toEqual([expect.objectContaining({ owner: "acme", repo: "shop", head: branch, base: "feature/rename", draft: true })]);
    expect(api.prs[0]!.body).toContain("Verification");

    // The fix commit sits directly on the target branch and touches only the verified SQL files.
    expect(g(bare, "rev-parse", `${branch}^`)).toBe(target);
    expect(g(bare, "diff", "--name-only", target, branch).split("\n").sort()).toEqual(["sql/add.sql", "sql/names.sql"]);
    expect(g(bare, "show", `${branch}:sql/names.sql`)).toBe("SELECT id, full_name AS name FROM customers ORDER BY id");

    // The user's checkout is untouched: same HEAD, branch, dirty files, and no leftover worktree or branch.
    expect(snapshot(repo)).toEqual(before);
  });

  it("refuses to overwrite an existing fix branch (no force pushes)", async () => {
    const { repo } = setup();
    const api = new FakeGitHub();
    expect((await publishFixPr(opts(repo, api))).status).toBe("opened");
    const again = await publishFixPr(opts(repo, api));
    expect(again.status).toBe("refused");
    expect(again.message).toContain("already exists");
    expect(api.prs).toHaveLength(1);
  });

  it("refuses when --repo does not match the configured remote", async () => {
    const { repo } = setup();
    const res = await publishFixPr(opts(repo, new FakeGitHub(), { repo: "someone-else/shop" }));
    expect(res).toMatchObject({ status: "refused", exitCode: 2 });
    expect(res.message).toContain("does not match");
  });

  it("refuses partial fixes and pushes nothing", async () => {
    const { repo, bare } = setup({
      "db/migrations/001_rename.sql": "ALTER TABLE customers RENAME COLUMN name TO full_name;\n",
      "db/migrations/002_req.sql": "ALTER TABLE customers ADD COLUMN email text NOT NULL DEFAULT ''; ALTER TABLE customers ALTER COLUMN email DROP DEFAULT;\n",
    });
    const api = new FakeGitHub();
    const res = await publishFixPr(opts(repo, api));
    expect(res.status).toBe("refused");
    expect(res.fix?.outcome).toBe("partial");
    expect(g(bare, "branch", "--list", "crashpad/*")).toBe("");
    expect(api.prs).toEqual([]);
  });

  it("refuses a stale plan when the target branch changed after verification", async () => {
    const { repo } = setup();
    const dry = await publishFixPr(opts(repo, null, { dryRun: true }));
    expect(dry.status).toBe("dry-run");
    const plan = dry.fix!.plan;
    // Someone pushes another commit to the target branch.
    g(repo.dir, "stash", "-q", "-u");
    g(repo.dir, "switch", "-q", "feature/rename");
    repo.write({ "sql/add.sql": "INSERT INTO customers (id, name) VALUES ($1, upper($2))\n" });
    repo.commit("tweak");
    g(repo.dir, "push", "-q", "origin", "feature/rename");
    g(repo.dir, "switch", "-q", "main");
    const api = new FakeGitHub();
    const res = await publishFixPr(opts(repo, api, { plan }));
    expect(res.status).toBe("refused");
    expect(res.message).toContain("stale plan");
    expect(api.prs).toEqual([]);
  });

  it("refuses a plan that was not verified", async () => {
    const { repo } = setup();
    const dry = await publishFixPr(opts(repo, null, { dryRun: true }));
    const res = await publishFixPr(opts(repo, new FakeGitHub(), { plan: { ...dry.fix!.plan, outcome: "partial", publishable: false } }));
    expect(res.status).toBe("refused");
  });

  it("reports the pushed branch for recovery when PR creation fails", async () => {
    const { repo, bare } = setup();
    const api = new FakeGitHub();
    api.failCreatePr = true;
    const res = await publishFixPr(opts(repo, api));
    expect(res.status).toBe("pushed-pr-failed");
    expect(res.exitCode).toBe(2);
    expect(res.message).toContain(res.branch!);
    expect(res.recovery).toContain(`--head ${res.branch}`);
    expect(res.recovery).toContain("--base feature/rename");
    expect(g(bare, "branch", "--list", res.branch!)).toContain(res.branch!);
  });
});

describe("PR comments", () => {
  it("creates one comment and updates it on later runs", async () => {
    const repo = TestRepo.create(projectFiles({ schema: SCHEMA, checks: [{ id: "a", category: "read", sql: "SELECT 1" }] }));
    const { report } = await check(repo);
    const api = new FakeGitHub();
    api.comments.push({ id: 99, body: "unrelated comment" });
    expect((await upsertComment(api, "acme", "shop", 1, commentBody(report))).action).toBe("created");
    expect((await upsertComment(api, "acme", "shop", 1, commentBody(report, "https://example.test/run"))).action).toBe("updated");
    expect(api.comments.filter((c) => c.body.includes(COMMENT_MARKER))).toHaveLength(1);
    expect(api.comments.find((c) => c.id === 99)!.body).toBe("unrelated comment");
  });

  it("does not fail the job when the token cannot comment (fork PRs)", async () => {
    const dir = tempDir();
    const repo = TestRepo.create(projectFiles({ schema: SCHEMA, checks: [] }));
    const { report } = await check(repo);
    const file = path.join(dir, "r.json");
    (await import("node:fs")).writeFileSync(file, JSON.stringify(report));
    const denied = new FakeGitHub();
    denied.listIssueComments = async () => {
      throw new GitHubHttpError(403, "Resource not accessible by integration");
    };
    const code = await cmdComment({ report: file, repo: "acme/shop", pr: "3" } as never, dir, denied);
    expect(code).toBe(0);
  });
});
