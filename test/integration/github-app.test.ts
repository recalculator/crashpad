import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectCompanion } from "../../src/commands/companion.ts";
import { main as cliMain } from "../../src/cli.ts";
import { ServiceClient, type CompanionConfig } from "../../src/companion/client.ts";
import { runCompanion } from "../../src/companion/worker.ts";
import { gitOut, git } from "../../src/git.ts";
import { CHECK_NAME, CrashpadService, REPAIR_CHECK_NAME } from "../../src/service/server.ts";
import { evaluatePullRequest, mayStartRepair, DEFAULT_REPAIR_POLICY } from "../../src/service/policy.ts";
import { DB_URL, tempDir } from "../helpers/project.ts";
import { FakeGitHubServer } from "../helpers/fake-github-server.ts";
import { buildScenarioRepo, loadScenarios, NOTES_API, NOTES_SCENARIOS } from "../helpers/scenario.ts";

/**
 * The account-wide GitHub integration, end to end on this machine:
 * REAL: the Crashpad service (HTTP), the companion, Git (a bare repository stands in
 * for GitHub's storage), PostgreSQL, the notes-api app processes, discovery.
 * FAKE: GitHub's REST API and device flow (test/helpers/fake-github-server.ts) and
 * the Claude Code CLI (test/fixtures/fake-claude). Nothing here talks to github.com,
 * so it does not establish that a live GitHub App registration works.
 */

const SECRET = "webhook-secret-for-tests";
const FAKE_CLAUDE = path.resolve(import.meta.dirname, "../fixtures/fake-claude/claude");
const REPO = "acme/notes";
const WEB = "https://github.example";

let gh: FakeGitHubServer;
let svc: CrashpadService;
let svcUrl: string;
let bare: string;
let main: string;
let headSha: string;
let comp: CompanionConfig;
let delivery = 0;

async function hook(event: string, payload: object, opts: { badSignature?: boolean; id?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", opts.badSignature ? "wrong" : SECRET).update(body).digest("hex")}`;
  const res = await fetch(`${svcUrl}/github/webhook`, { method: "POST", headers: { "x-github-event": event, "x-hub-signature-256": sig, "x-github-delivery": opts.id ?? `d${++delivery}`, "content-type": "application/json" }, body });
  return { status: res.status, body: (await res.json()) as any };
}

function pr(n: number, sha: string, o: { ref?: string; fork?: boolean; association?: string; login?: string; type?: string; action?: string; repo?: string } = {}) {
  const repo = o.repo ?? REPO;
  return {
    action: o.action ?? "opened",
    number: n,
    installation: { id: 7 },
    repository: { full_name: repo },
    sender: { login: o.login ?? "maintainer" },
    pull_request: {
      number: n,
      head: { sha, ref: o.ref ?? "change", repo: { full_name: o.fork ? "stranger/notes" : repo } },
      base: { sha: main, ref: "main", repo: { full_name: repo } },
      user: { login: o.login ?? "maintainer", type: o.type ?? "User" },
      author_association: o.association ?? "OWNER",
    },
  };
}

function companionRun(cfg: CompanionConfig, extra: Record<string, string> = {}) {
  return runCompanion({ client: new ServiceClient(cfg.service, cfg.token), config: cfg, databaseUrl: DB_URL, log: () => {}, once: true, waitMs: 1000, claudeBin: FAKE_CLAUDE, claudeEnv: { FAKE_CLAUDE_MODE: "fix-permission", ...extra } });
}

beforeAll(async () => {
  process.env.CRASHPAD_HOME = tempDir("crashpad-home-");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  gh = new FakeGitHubServer(publicKey);
  await gh.start();

  // The repository "on GitHub": a real bare repo with main and a PR branch containing a permission regression.
  const s = loadScenarios(NOTES_SCENARIOS).find((x) => x.name === "n05-permission-regression")!;
  const work = buildScenarioRepo(s, tempDir(), NOTES_API);
  bare = path.join(tempDir(), "notes.git");
  await git(path.dirname(bare), ["init", "-q", "--bare", bare]);
  await git(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(work, ["push", "-q", bare, "main", "change"]);
  main = await gitOut(bare, ["rev-parse", "main"]);
  headSha = await gitOut(bare, ["rev-parse", "change"]);
  gh.bareRepos.set(REPO, bare);
  gh.prState.set(`${REPO}#1`, { head: { sha: headSha, ref: "change", repo: { full_name: REPO } }, base: { sha: main, ref: "main", repo: { full_name: REPO } }, state: "open" });
  gh.permissions.set("maintainer", "admin");
  gh.permissions.set("reader", "read");
  gh.users.set("maintainer", { id: 1, login: "maintainer", installations: [7] });
  gh.users.set("outsider", { id: 2, login: "outsider", installations: [] });
  // Clones of https://github.example/acme/notes.git resolve to the bare repository.
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${bare}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = `${WEB}/${REPO}.git`;

  svc = new CrashpadService({ appId: gh.appId, privateKeyPem: privateKey, webhookSecret: SECRET, apiUrl: gh.url, webUrl: WEB, clientId: gh.clientId, appSlug: gh.slug, dataFile: path.join(tempDir(), "state.json"), onlineWindowMs: 60_000 });
  svcUrl = `http://127.0.0.1:${await svc.listen(0)}`;
});

afterAll(async () => {
  await svc?.close();
  await gh?.stop();
  for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete process.env[k];
});

describe("GitHub App service + local companion (fake GitHub, real service/companion/Git/PostgreSQL)", () => {
  it("rejects webhooks without a valid signature", async () => {
    expect((await hook("ping", {}, { badSignature: true })).status).toBe(401);
    expect((await hook("ping", {})).status).toBe(200);
  });

  it("records the installation's repository selection and pairs a companion through the device flow", async () => {
    expect((await hook("installation", { action: "created", installation: { id: 7, account: { login: "acme" }, repository_selection: "selected" }, repositories: [{ full_name: REPO }] })).status).toBe(200);
    // A user who cannot access the installation cannot pair.
    gh.deviceApproved.set("next", "outsider");
    await expect(connectCompanion({ service: svcUrl, githubUrl: gh.url, name: "intruder", onCode: () => {} })).rejects.toThrow(/cannot access any installation/);
    gh.deviceApproved.set("next", "maintainer");
    let shown = "";
    comp = await connectCompanion({ service: svcUrl, githubUrl: gh.url, name: "laptop", onCode: (c) => (shown = c.userCode), repair: { enabled: true, maxAttempts: 1 } });
    expect(shown).toBe("ABCD-1234");
    expect(comp).toMatchObject({ login: "maintainer", name: "laptop" });
    expect(comp.token).toMatch(/^cpc_/);
    const saved = fs.readFileSync(path.join(process.env.CRASHPAD_HOME!, "companion.json"), "utf8");
    expect(saved).not.toContain("ghu_fake"); // the GitHub user token is never stored
    expect((fs.statSync(path.join(process.env.CRASHPAD_HOME!, "companion.json")).mode & 0o777).toString(8)).toBe("600");
  });

  it("ignores repositories outside the selection and reports honestly while the companion is offline", async () => {
    expect((await hook("pull_request", pr(9, headSha, { repo: "acme/other" }))).body.ignored).toMatch(/not in this installation's selection/);
    const r = await hook("pull_request", pr(1, headSha));
    expect(r.body.status).toBe("queued");
    const run = gh.run(CHECK_NAME, headSha)!;
    expect(run.status).toBe("queued");
    expect(run.output?.title).toMatch(/offline/);
    expect(run.output?.summary).toMatch(/Nothing has been checked yet/);
    // A redelivered event and a duplicate for the same commit do not create more work.
    expect((await hook("pull_request", pr(1, headSha), { id: `d${delivery}` })).body.duplicate).toBe(true);
    expect((await hook("pull_request", pr(1, headSha, { action: "reopened" }))).body.deduplicated).toBe(true);
  });

  it("runs the check on the companion at the exact head commit and publishes the result", async () => {
    const handled = await companionRun(comp);
    expect(handled).toEqual([{ job: expect.any(String), status: "completed" }]);
    const run = gh.run(CHECK_NAME, headSha)!;
    expect(run.status).toBe("completed");
    expect(run.conclusion).toBe("failure");
    expect(run.output?.title).toMatch(/1 of \d+ check\(s\) broke/);
    expect(run.output?.summary).toContain("permissions:note-visible-to-owner-and-admin");
    expect(run.actions?.map((a) => a.identifier)).toEqual(["repair"]);
    expect(run.history.some((h) => h.status === "in_progress")).toBe(true);
    // Once the companion's heartbeat arrived, the pending text stopped saying "offline".
    expect(run.history.some((h) => (h.output as { title?: string } | undefined)?.title === "Queued on your Crashpad companion")).toBe(true);
    // The companion's clone used a token scoped to this one repository, read-only.
    expect([...gh.tokens.values()].some((t) => t.repositories?.join() === "notes" && t.permissions.contents === "read")).toBe(true);
    // Automatic repair is opt-in: nothing was queued.
    expect(svc.store.jobs().filter((j) => j.kind === "repair")).toHaveLength(0);
  });

  it("repairs on request by a writer, verifies locally, and opens a draft fix PR on top of the head commit", async () => {
    const run = gh.run(CHECK_NAME, headSha)!;
    const action = (login: string) => hook("check_run", { action: "requested_action", installation: { id: 7 }, repository: { full_name: REPO }, sender: { login }, check_run: { id: run.id, head_sha: headSha }, requested_action: { identifier: "repair" } });
    expect((await action("reader")).status).toBe(403);
    expect((await action("maintainer")).status).toBe(200);
    expect((await action("maintainer")).status).toBe(409); // one repair per commit
    const handled = await companionRun(comp);
    expect(handled[0]!.status).toBe("published");
    const repairRun = gh.run(REPAIR_CHECK_NAME, headSha)!;
    expect(repairRun.conclusion).toBe("success");
    const fixPr = gh.pulls.at(-1)!;
    expect(fixPr).toMatchObject({ base: "change", draft: true });
    expect(fixPr.head).toBe(`crashpad/fix-change-${headSha.slice(0, 8)}`);
    expect(fixPr.body).toContain("verified independently by Crashpad");
    expect(await gitOut(bare, ["rev-parse", `${fixPr.head}^`])).toBe(headSha);
    expect(await gitOut(bare, ["diff", "--name-only", headSha, fixPr.head])).toBe("server.js");
    expect(await gitOut(bare, ["log", "-1", "--format=%B", fixPr.head])).toMatch(/Crashpad-Repair: /);
  });

  it("checks Crashpad's own fix PR but never offers or runs a repair for it", async () => {
    const fixPr = gh.pulls.at(-1)!;
    const fixSha = await gitOut(bare, ["rev-parse", fixPr.head]);
    gh.prState.set(`${REPO}#${fixPr.number}`, { head: { sha: fixSha, ref: fixPr.head, repo: { full_name: REPO } }, base: { sha: headSha, ref: "change", repo: { full_name: REPO } }, state: "open" });
    const p = pr(fixPr.number, fixSha, { ref: fixPr.head, login: `${gh.slug}[bot]`, type: "Bot", association: "NONE" });
    p.pull_request.base = { sha: headSha, ref: "change", repo: { full_name: REPO } };
    await svc.setPolicy(svc.store.companionByToken(comp.token)!, REPO, { autoRepair: true });
    expect((await hook("pull_request", p)).body.status).toBe("queued");
    await companionRun(comp);
    const run = gh.run(CHECK_NAME, fixSha)!;
    expect(run.status).toBe("completed");
    expect(run.actions ?? []).toEqual([]);
    expect(svc.store.jobs().filter((j) => j.kind === "repair" && j.headSha === fixSha)).toHaveLength(0);
    await svc.setPolicy(svc.store.companionByToken(comp.token)!, REPO, { autoRepair: false });
  });

  it("replaces stale work when the PR moves: superseded jobs are cancelled and their results discarded", async () => {
    // Two new commits on the PR branch.
    const work = tempDir();
    await git(work, ["clone", "-q", bare, "w"]);
    const w = path.join(work, "w");
    await git(w, ["checkout", "-q", "change"]);
    const commit = async (msg: string) => {
      fs.appendFileSync(path.join(w, "README.md"), `${msg}\n`);
      await git(w, ["add", "-A"]);
      await git(w, ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", msg]);
      await git(w, ["push", "-q", "origin", "change"]);
      return gitOut(w, ["rev-parse", "HEAD"]);
    };
    const sha1 = await commit("one");
    const sha2 = await commit("two");
    await hook("pull_request", pr(1, sha1, { action: "synchronize" }));
    const client = new ServiceClient(comp.service, comp.token);
    const leased = (await client.lease(0))!;
    expect(leased.headSha).toBe(sha1);
    await hook("pull_request", pr(1, sha2, { action: "synchronize" }));
    expect(gh.run(CHECK_NAME, sha1)!.conclusion).toBe("cancelled");
    expect(gh.run(CHECK_NAME, sha1)!.output?.title).toMatch(/Superseded by/);
    expect((await client.progress(leased.id))!.cancel).toBe(true);
    await expect(client.complete(leased.id, { exitCode: 0, headline: "stale", markdown: "" })).rejects.toThrow(/superseded/);
    const next = (await client.lease(0))!;
    expect(next.headSha).toBe(sha2);
    await client.complete(next.id, { exitCode: 0, headline: "ok", markdown: "ok" });
  });

  it("requires approval by a writer before running a fork PR, and never repairs it", async () => {
    const r = await hook("pull_request", pr(5, headSha, { fork: true, association: "CONTRIBUTOR", login: "stranger" }));
    expect(r.body.status).toBe("awaiting-approval");
    const run = gh.run(CHECK_NAME)!;
    expect(run.conclusion).toBe("action_required");
    expect(run.actions?.map((a) => a.identifier)).toEqual(["approve-run"]);
    const client = new ServiceClient(comp.service, comp.token);
    expect(await client.lease(0)).toBeNull();
    const approve = (login: string) => hook("check_run", { action: "requested_action", installation: { id: 7 }, repository: { full_name: REPO }, sender: { login }, check_run: { id: run.id }, requested_action: { identifier: "approve-run" } });
    expect((await approve("reader")).status).toBe(403);
    expect((await approve("maintainer")).status).toBe(200);
    const job = (await client.lease(0))!;
    expect(job.repairable).toBe(false);
    await client.complete(job.id, { exitCode: 1, headline: "broke", markdown: "x" });
    expect(gh.run(CHECK_NAME)!.actions ?? []).toEqual([]);
  });

  it("starts repairs automatically only when the owner opts in, and only on companions with repairs enabled", async () => {
    const c = svc.store.companionByToken(comp.token)!;
    svc.setPolicy(c, REPO, { autoRepair: true, maxRepairsPerPr: 5 });
    await hook("pull_request", pr(2, headSha, { ref: "change" }));
    const client = new ServiceClient(comp.service, comp.token);
    const job = (await client.lease(0))!;
    const done = (await client.complete(job.id, { exitCode: 1, headline: "broke", markdown: "x" }))!;
    expect(done.repair).toEqual(expect.any(String));
    const off = { ...comp, repair: { ...comp.repair, enabled: false } };
    const handled = await companionRun(off);
    expect(handled[0]!.status).toBe("repair-disabled");
    expect(gh.run(REPAIR_CHECK_NAME)!.output?.title).toMatch(/turned off/);
    svc.setPolicy(c, REPO, { autoRepair: false });
  });

  it("onboards the installation's repositories: discovery from the default branch, results in Crashpad's storage", async () => {
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => ((out += c), true)) as typeof process.stdout.write;
    try {
      expect(await cliMain(["setup", "--database-url", DB_URL], tempDir())).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(out).toContain("GitHub: connected as maintainer");
    expect(out).toContain(`acme/notes @ ${main.slice(0, 12)}`);
    for (const area of ["Database compatibility", "API contracts", "Configuration and startup", "Permissions", "Application workflows"]) expect(out).toMatch(new RegExp(`${area}\\s+ready`));
    expect(out).toContain("Nothing was written to the repository");
    const stored = fs.readdirSync(path.join(process.env.CRASHPAD_HOME!, "repos")).map((d) => path.join(process.env.CRASHPAD_HOME!, "repos", d, "onboarding.json")).find((f) => fs.existsSync(f));
    expect(JSON.parse(fs.readFileSync(stored!, "utf8"))).toMatchObject({ repo: REPO, commit: main });
    expect(await gitOut(bare, ["rev-parse", "main"])).toBe(main);
  });

  it("stops serving a repository removed from the installation", async () => {
    await hook("installation_repositories", { action: "removed", installation: { id: 7, account: { login: "acme" } }, repository_selection: "selected", repositories_removed: [{ full_name: REPO }] });
    expect((await hook("pull_request", pr(3, headSha))).body.ignored).toMatch(/selection/);
    await expect(new ServiceClient(comp.service, comp.token).call("POST", "/api/companion/token", { repo: REPO })).rejects.toThrow(/not in an installation/);
    await hook("installation_repositories", { action: "added", installation: { id: 7, account: { login: "acme" } }, repository_selection: "selected", repositories_added: [{ full_name: REPO }] });
  });

  it("rejects requests with an invalid companion token", async () => {
    await expect(new ServiceClient(svcUrl, `cpc_${randomBytes(8).toString("hex")}`).status()).rejects.toThrow(/invalid or revoked/);
  });
});

describe("trusted-source and loop-prevention policy", () => {
  const base = { baseRepo: "acme/notes", headRepo: "acme/notes", headRef: "feature", authorLogin: "dev", authorType: "User", authorAssociation: "MEMBER" };
  it("trusts same-repository branches by owners, members, and collaborators only", () => {
    expect(evaluatePullRequest(base, "crashpad[bot]")).toMatchObject({ trusted: true, repairable: true });
    expect(evaluatePullRequest({ ...base, headRepo: "someone/notes" }, null)).toMatchObject({ trusted: false, repairable: false });
    expect(evaluatePullRequest({ ...base, headRepo: null }, null).trusted).toBe(false);
    expect(evaluatePullRequest({ ...base, authorAssociation: "FIRST_TIME_CONTRIBUTOR" }, null).trusted).toBe(false);
    expect(evaluatePullRequest({ ...base, headRef: "crashpad/fix-feature-1234abcd" }, null)).toMatchObject({ trusted: true, repairable: false });
    expect(evaluatePullRequest({ ...base, authorLogin: "crashpad[bot]", authorType: "Bot", authorAssociation: "NONE" }, "crashpad[bot]")).toMatchObject({ trusted: true, repairable: false });
  });
  it("bounds repairs per commit and per PR, and keeps automatic repair opt-in", () => {
    const d = { trusted: true, repairable: true, reason: "" };
    expect(mayStartRepair(d, DEFAULT_REPAIR_POLICY, 0, 0, "auto").ok).toBe(false);
    expect(mayStartRepair(d, DEFAULT_REPAIR_POLICY, 0, 0, "requested").ok).toBe(true);
    expect(mayStartRepair(d, DEFAULT_REPAIR_POLICY, 1, 1, "requested").ok).toBe(false);
    expect(mayStartRepair(d, DEFAULT_REPAIR_POLICY, 2, 0, "requested").ok).toBe(false);
    expect(mayStartRepair(d, { autoRepair: true, maxRepairsPerPr: 2 }, 0, 0, "auto").ok).toBe(true);
  });
});
