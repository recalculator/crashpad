import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { GitHubHttpError } from "../github/client.ts";
import { asUser, GitHubApp } from "./github-app.ts";
import { DEFAULT_REPAIR_POLICY, evaluatePullRequest, FIX_BRANCH_PREFIX, mayStartRepair, WRITE_PERMISSIONS, type RepairPolicy } from "./policy.ts";
import { isActive, ServiceStore, type Companion, type Installation, type Job } from "./store.ts";
import { VERSION } from "../version.ts";

/**
 * The Crashpad GitHub App service. It is the always-on half of the account-wide
 * integration: it receives the App's webhooks, decides what may run, keeps the job
 * queue, publishes check runs, and opens verified fix PRs. It never runs a
 * repository's code and never talks to Claude: the paired companion on the
 * owner's machine does that, with the owner's own Claude Code sign-in.
 */

export interface ServiceConfig {
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
  /** REST API base, default https://api.github.com. */
  apiUrl: string;
  /** Web/Git base for clone URLs, default https://github.com. */
  webUrl: string;
  /** OAuth client id of the App (device flow pairing). */
  clientId?: string;
  /** App slug; its bot login is `<slug>[bot]` (loop prevention). */
  appSlug?: string;
  dataFile: string | null;
  /** A companion counts as online if it sent a heartbeat this recently. */
  onlineWindowMs?: number;
  /** A leased job without progress for this long is handed out again. */
  leaseMs?: number;
  log?: (msg: string) => void;
}

export const CHECK_NAME = "Crashpad";
export const REPAIR_CHECK_NAME = "Crashpad repair";
const MAX_SUMMARY = 65_000;

interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title?: string;
  message: string;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

async function readBody(req: http.IncomingMessage, limit = 5 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export class CrashpadService {
  readonly store: ServiceStore;
  readonly app: GitHubApp;
  readonly cfg: Required<Pick<ServiceConfig, "onlineWindowMs" | "leaseMs">> & ServiceConfig;
  private events = new EventEmitter();
  private server: http.Server | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private log: (m: string) => void;

  constructor(cfg: ServiceConfig) {
    this.cfg = { onlineWindowMs: 60_000, leaseMs: 10 * 60_000, ...cfg };
    this.store = new ServiceStore(cfg.dataFile);
    this.app = new GitHubApp({ appId: cfg.appId, privateKeyPem: cfg.privateKeyPem, apiUrl: cfg.apiUrl });
    this.log = cfg.log ?? (() => {});
    this.events.setMaxListeners(1000);
  }

  get botLogin(): string | null {
    return this.cfg.appSlug ? `${this.cfg.appSlug}[bot]` : null;
  }

  // ---------------------------------------------------------------- presence

  online(installationId: number): Companion[] {
    const now = Date.now();
    return this.store.companions().filter((c) => !c.revoked && c.installations.includes(installationId) && c.lastSeen && now - Date.parse(c.lastSeen) < this.cfg.onlineWindowMs);
  }

  private presenceText(installationId: number): { title: string; summary: string } {
    const on = this.online(installationId);
    if (on.length) return { title: "Queued on your Crashpad companion", summary: `Waiting for ${on.map((c) => `\`${c.name}\``).join(", ")} to pick this up. Crashpad runs checks on the owner's computer.` };
    const paired = this.store.companions().filter((c) => !c.revoked && c.installations.includes(installationId));
    if (!paired.length) return { title: "No Crashpad companion connected", summary: "No companion is paired for this installation, so nothing can run yet. Run `crashpad connect` on the computer that should run checks." };
    const last = paired.map((c) => c.lastSeen).filter(Boolean).sort().at(-1);
    return {
      title: "Waiting: your Crashpad companion is offline",
      summary: `The companion ${paired.map((c) => `\`${c.name}\``).join(", ")} was last seen ${last ?? "never"}. Checks and repairs run on that computer, so this stays pending until it reconnects (\`crashpad companion\`). Nothing has been checked yet.`,
    };
  }

  // ---------------------------------------------------------------- GitHub calls

  private gh<T>(job: { installationId: number }, method: string, path: string, body?: unknown): Promise<T> {
    return this.app.asInstallation<T>(job.installationId, method, path, body);
  }

  private async createCheckRun(job: Job, name: string, fields: Record<string, unknown>): Promise<number> {
    const r = await this.gh<{ id: number }>(job, "POST", `/repos/${job.repo}/check-runs`, { name, head_sha: job.headSha, external_id: job.id, ...fields });
    return r.id;
  }

  private async updateCheckRun(job: Job, fields: Record<string, unknown>): Promise<void> {
    if (!job.checkRunId) return;
    await this.gh(job, "PATCH", `/repos/${job.repo}/check-runs/${job.checkRunId}`, fields);
  }

  // ---------------------------------------------------------------- jobs

  private newJob(base: Omit<Job, "id" | "status" | "checkRunId" | "leasedBy" | "leaseExpires" | "attempts" | "createdAt" | "updatedAt">, status: Job["status"]): Job {
    const now = new Date().toISOString();
    return { ...base, id: randomBytes(8).toString("hex"), status, checkRunId: null, leasedBy: null, leaseExpires: null, attempts: 0, createdAt: now, updatedAt: now };
  }

  private async enqueueCheck(p: { installationId: number; repo: string; pr: any; rerun?: boolean }): Promise<Job | null> {
    const pr = p.pr;
    const headSha: string = pr.head.sha;
    const decision = evaluatePullRequest(
      { baseRepo: pr.base.repo.full_name, headRepo: pr.head.repo?.full_name ?? null, headRef: pr.head.ref, authorLogin: pr.user.login, authorType: pr.user.type, authorAssociation: pr.author_association },
      this.botLogin,
    );
    // Replace stale work for this PR: jobs for an older head commit are superseded.
    for (const j of this.store.jobs()) {
      if (j.repo === p.repo && j.prNumber === pr.number && isActive(j) && j.headSha !== headSha) {
        this.store.update(j, { status: "superseded", supersededBy: headSha });
        await this.updateCheckRun(j, { status: "completed", conclusion: "cancelled", output: { title: `Superseded by ${headSha.slice(0, 8)}`, summary: `The pull request moved to ${headSha}; this run for ${j.headSha.slice(0, 8)} was cancelled.` } }).catch(() => {});
      }
    }
    const dedupeKey = `check:${p.repo}#${pr.number}:${headSha}`;
    const existing = this.store.jobs().find((j) => j.dedupeKey === dedupeKey && j.kind === "check" && (isActive(j) || (!p.rerun && j.status === "completed")));
    if (existing) {
      this.log(`dedupe: ${dedupeKey} already ${existing.status}`);
      return null;
    }
    const job = this.newJob(
      { kind: "check", installationId: p.installationId, repo: p.repo, prNumber: pr.number, headSha, baseSha: pr.base.sha, headRef: pr.head.ref, baseRef: pr.base.ref, trusted: decision.trusted, repairable: decision.repairable, policyReason: decision.reason, dedupeKey },
      decision.trusted ? "queued" : "awaiting-approval",
    );
    this.store.addJob(job);
    if (decision.trusted) {
      job.checkRunId = await this.createCheckRun(job, CHECK_NAME, { status: "queued", output: this.presenceText(job.installationId) });
      this.events.emit("job");
    } else {
      job.checkRunId = await this.createCheckRun(job, CHECK_NAME, {
        status: "completed",
        conclusion: "action_required",
        output: { title: "Approval needed before Crashpad runs this pull request", summary: `Crashpad runs a pull request's code and SQL on the owner's computer. This one is not run automatically: ${decision.reason}. A user with write access can approve a run with the button below.` },
        actions: [{ label: "Run Crashpad", identifier: "approve-run", description: "Approve running this PR's code" }],
      });
    }
    this.store.update(job, {});
    return job;
  }

  private async enqueueRepair(check: Job, trigger: "auto" | "requested", requestedBy?: string): Promise<{ job: Job | null; reason: string }> {
    const policy = this.repoPolicy(check.repo);
    const prior = this.store.jobs().filter((j) => j.kind === "repair" && j.repo === check.repo && j.prNumber === check.prNumber);
    const decision = mayStartRepair({ trusted: check.trusted, repairable: check.repairable, reason: check.policyReason }, policy, prior.length, prior.filter((j) => j.headSha === check.headSha).length, trigger);
    if (!decision.ok) return { job: null, reason: decision.reason };
    const job = this.newJob(
      { kind: "repair", installationId: check.installationId, repo: check.repo, prNumber: check.prNumber, headSha: check.headSha, baseSha: check.baseSha, headRef: check.headRef, baseRef: check.baseRef, trusted: check.trusted, repairable: check.repairable, policyReason: check.policyReason, dedupeKey: `repair:${check.repo}#${check.prNumber}:${check.headSha}`, trigger, ...(requestedBy ? { requestedBy } : {}) },
      "queued",
    );
    this.store.addJob(job);
    job.checkRunId = await this.createCheckRun(job, REPAIR_CHECK_NAME, { status: "queued", output: this.presenceText(job.installationId) });
    this.store.update(job, {});
    this.events.emit("job");
    return { job, reason: decision.reason };
  }

  repoPolicy(repo: string): RepairPolicy {
    return this.store.policy(repo)?.repair ?? DEFAULT_REPAIR_POLICY;
  }

  private async hasWriteAccess(installationId: number, repo: string, login: string): Promise<boolean> {
    try {
      const r = await this.app.asInstallation<{ permission: string }>(installationId, "GET", `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
      return WRITE_PERMISSIONS.has(r.permission);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- webhooks

  async handleWebhook(event: string, payload: any): Promise<{ status: number; body: unknown }> {
    const installationId: number | undefined = payload.installation?.id;
    switch (event) {
      case "ping":
        return { status: 200, body: { ok: true } };
      case "installation": {
        const inst = payload.installation;
        if (payload.action === "deleted") {
          this.store.deleteInstallation(inst.id);
          return { status: 200, body: { removed: inst.id } };
        }
        const prev = this.store.installation(inst.id);
        const repos = (payload.repositories ?? []).map((r: { full_name: string }) => r.full_name.toLowerCase());
        const i: Installation = {
          id: inst.id,
          account: inst.account?.login ?? "",
          repositorySelection: inst.repository_selection === "all" ? "all" : "selected",
          repositories: payload.action === "created" ? repos : (prev?.repositories ?? repos),
          suspended: payload.action === "suspend" ? true : payload.action === "unsuspend" ? false : (prev?.suspended ?? false),
        };
        this.store.putInstallation(i);
        return { status: 200, body: { installation: i.id, repositories: i.repositories.length } };
      }
      case "installation_repositories": {
        const prev = this.store.installation(payload.installation.id);
        const set = new Set(prev?.repositories ?? []);
        for (const r of payload.repositories_added ?? []) set.add(r.full_name.toLowerCase());
        for (const r of payload.repositories_removed ?? []) set.delete(r.full_name.toLowerCase());
        this.store.putInstallation({
          id: payload.installation.id,
          account: payload.installation.account?.login ?? prev?.account ?? "",
          repositorySelection: payload.repository_selection === "all" ? "all" : "selected",
          repositories: [...set].sort(),
          suspended: prev?.suspended ?? false,
        });
        for (const r of payload.repositories_removed ?? []) {
          for (const j of this.store.jobs()) if (j.repo.toLowerCase() === r.full_name.toLowerCase() && isActive(j)) this.store.update(j, { status: "cancelled" });
        }
        return { status: 200, body: { repositories: set.size } };
      }
      case "pull_request": {
        const repo: string = payload.repository.full_name;
        if (!installationId || !this.store.repoAllowed(installationId, repo)) return { status: 202, body: { ignored: "repository is not in this installation's selection" } };
        if (payload.action === "closed") {
          for (const j of this.store.jobs()) {
            if (j.repo === repo && j.prNumber === payload.number && isActive(j)) {
              this.store.update(j, { status: "cancelled" });
              await this.updateCheckRun(j, { status: "completed", conclusion: "cancelled", output: { title: "Pull request closed", summary: "Cancelled because the pull request was closed." } }).catch(() => {});
            }
          }
          return { status: 200, body: { cancelled: true } };
        }
        if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(payload.action)) return { status: 202, body: { ignored: payload.action } };
        const job = await this.enqueueCheck({ installationId, repo, pr: payload.pull_request });
        return { status: 200, body: job ? { job: job.id, status: job.status } : { deduplicated: true } };
      }
      case "check_run": {
        const run = payload.check_run;
        const repo: string = payload.repository.full_name;
        if (!installationId || !this.store.repoAllowed(installationId, repo)) return { status: 202, body: { ignored: "repository is not in this installation's selection" } };
        const job = this.store.jobs().find((j) => j.checkRunId === run.id);
        if (!job) return { status: 202, body: { ignored: "unknown check run" } };
        if (payload.action === "requested_action") {
          const id = payload.requested_action?.identifier;
          const login: string = payload.sender.login;
          if (!(await this.hasWriteAccess(installationId, repo, login))) return { status: 403, body: { refused: `${login} does not have write access` } };
          if (id === "approve-run" && job.status === "awaiting-approval") {
            this.store.update(job, { status: "queued", requestedBy: login });
            job.checkRunId = await this.createCheckRun(job, CHECK_NAME, { status: "queued", output: this.presenceText(job.installationId) });
            this.store.update(job, {});
            this.events.emit("job");
            return { status: 200, body: { approved: job.id } };
          }
          if (id === "repair" && job.kind === "check" && job.status === "completed") {
            const r = await this.enqueueRepair(job, "requested", login);
            return { status: r.job ? 200 : 409, body: r.job ? { repair: r.job.id } : { refused: r.reason } };
          }
          return { status: 409, body: { refused: `action ${id} is not available for this run` } };
        }
        if (payload.action === "rerequested" && job.kind === "check") {
          const pr = await this.gh<any>(job, "GET", `/repos/${repo}/pulls/${job.prNumber}`);
          if (pr.head.sha !== job.headSha) return { status: 409, body: { refused: "the pull request has moved on; the new commit is checked instead" } };
          const j = await this.enqueueCheck({ installationId, repo, pr, rerun: true });
          return { status: 200, body: j ? { job: j.id } : { deduplicated: true } };
        }
        return { status: 202, body: { ignored: payload.action } };
      }
      default:
        return { status: 202, body: { ignored: event } };
    }
  }

  // ---------------------------------------------------------------- companion API

  async register(body: { githubToken?: string; name?: string }): Promise<{ token: string; companion: { id: string; login: string; installations: number[] } }> {
    if (!body.githubToken) throw new HttpError(400, "githubToken is required");
    // The user token is used only for these two calls and is not stored.
    let user: { id: number; login: string };
    let insts: { installations: Array<{ id: number; app_id?: number }> };
    try {
      user = await asUser(this.cfg.apiUrl, body.githubToken, "GET", "/user");
      insts = await asUser(this.cfg.apiUrl, body.githubToken, "GET", "/user/installations?per_page=100");
    } catch (err) {
      throw new HttpError(401, `GitHub did not accept the sign-in: ${(err as Error).message}`);
    }
    const ids = insts.installations.filter((i) => !i.app_id || String(i.app_id) === this.cfg.appId).map((i) => i.id).filter((id) => this.store.installation(id));
    if (!ids.length) throw new HttpError(403, `${user.login} cannot access any installation of this GitHub App. Install the App on your account or organization first.`);
    const { companion, token } = this.store.createCompanion({ githubUserId: user.id, login: user.login, installations: ids, name: (body.name ?? "companion").slice(0, 60) });
    this.log(`paired companion ${companion.id} for ${user.login} (installations ${ids.join(", ")})`);
    return { token, companion: { id: companion.id, login: companion.login, installations: ids } };
  }

  private leasePayload = async (job: Job) => {
    const name = job.repo.split("/")[1]!;
    const tok = await this.app.installationToken(job.installationId, { repositories: [name], permissions: { contents: "read", metadata: "read" } });
    return {
      id: job.id,
      kind: job.kind,
      repo: job.repo,
      cloneUrl: `${this.cfg.webUrl.replace(/\/$/, "")}/${job.repo}.git`,
      token: tok.token,
      tokenExpiresAt: tok.expiresAt,
      prNumber: job.prNumber,
      headSha: job.headSha,
      baseSha: job.baseSha,
      headRef: job.headRef,
      baseRef: job.baseRef,
      repairable: job.repairable,
      leaseMs: this.cfg.leaseMs,
    };
  };

  private takeJob(c: Companion): Job | null {
    const now = Date.now();
    for (const j of this.store.jobs()) {
      if (j.status === "leased" && j.leaseExpires !== null && j.leaseExpires < now) {
        // The companion holding it stopped reporting: hand it out again, a bounded number of times.
        if (j.attempts >= 3) {
          this.store.update(j, { status: "failed", result: { exitCode: 2, headline: "The companion stopped responding" } });
          void this.updateCheckRun(j, { status: "completed", conclusion: "failure", output: { title: "Crashpad could not finish", summary: "The companion stopped responding three times. Nothing was verified." } }).catch(() => {});
        } else this.store.update(j, { status: "queued", leasedBy: null, leaseExpires: null });
      }
    }
    const candidates = this.store
      .jobs()
      .filter((j) => j.status === "queued" && c.installations.includes(j.installationId) && this.store.repoAllowed(j.installationId, j.repo))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return candidates[0] ?? null;
  }

  async lease(c: Companion, waitMs: number): Promise<object | null> {
    const deadline = Date.now() + Math.min(Math.max(0, waitMs), 25_000);
    while (true) {
      const job = this.takeJob(c);
      if (job) {
        this.store.update(job, { status: "leased", leasedBy: c.id, leaseExpires: Date.now() + this.cfg.leaseMs, attempts: job.attempts + 1 });
        await this.updateCheckRun(job, { status: "in_progress", started_at: new Date().toISOString(), output: { title: `Running on ${c.name}`, summary: `${job.kind === "repair" ? "Repairing" : "Checking"} ${job.headSha.slice(0, 12)} on the owner's companion \`${c.name}\`.` } }).catch(() => {});
        return this.leasePayload(job);
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.events.once("job", () => (clearTimeout(t), resolve()));
      });
    }
  }

  private owned(c: Companion, id: string): Job {
    const job = this.store.job(id);
    if (!job || job.leasedBy !== c.id) throw new HttpError(404, "no such job leased by this companion");
    return job;
  }

  progress(c: Companion, id: string): { cancel: boolean; status: string } {
    const job = this.owned(c, id);
    if (job.status !== "leased") return { cancel: true, status: job.status };
    this.store.update(job, { leaseExpires: Date.now() + this.cfg.leaseMs });
    return { cancel: false, status: job.status };
  }

  async complete(c: Companion, id: string, body: { exitCode: number; headline: string; markdown: string; annotations?: Annotation[]; message?: string }): Promise<object> {
    const job = this.owned(c, id);
    if (job.status !== "leased") throw new HttpError(409, `job is ${job.status}${job.supersededBy ? ` (superseded by ${job.supersededBy.slice(0, 8)})` : ""}; result discarded`);
    const ann = (body.annotations ?? []).slice(0, 500);
    const summary = body.markdown.length > MAX_SUMMARY ? `${body.markdown.slice(0, MAX_SUMMARY - 100)}\n\n…truncated` : body.markdown;
    const title = body.headline.slice(0, 250);
    let conclusion: string;
    if (job.kind === "check") conclusion = body.exitCode === 0 ? "success" : "failure";
    else conclusion = body.exitCode === 0 ? "success" : "neutral";
    const actions = job.kind === "check" && body.exitCode === 1 && job.repairable ? [{ label: "Repair with Claude", identifier: "repair", description: "Repair on the owner's companion" }] : [];
    await this.updateCheckRun(job, { status: "completed", conclusion, completed_at: new Date().toISOString(), output: { title, summary, annotations: ann.slice(0, 50) }, ...(actions.length ? { actions } : {}) });
    for (let i = 50; i < ann.length; i += 50) await this.updateCheckRun(job, { output: { title, summary, annotations: ann.slice(i, i + 50) } });
    this.store.update(job, { status: "completed", result: { exitCode: body.exitCode, headline: body.headline, ...(body.message ? { message: body.message } : {}) } });
    let repair: string | null = null;
    if (job.kind === "check" && body.exitCode === 1) {
      const r = await this.enqueueRepair(job, "auto");
      repair = r.job ? r.job.id : null;
    }
    return { ok: true, conclusion, repair };
  }

  /** Publish a fix verified on the companion: a new branch whose parent is the exact head commit, then a draft PR. */
  async publishFix(c: Companion, id: string, body: { files: Array<{ path: string; after: string | null }>; title: string; body: string; verification: { verified: boolean; exitCode: number; headline: string }; repairId: string }): Promise<object> {
    const job = this.owned(c, id);
    if (job.kind !== "repair") throw new HttpError(400, "only repair jobs publish fixes");
    if (job.status !== "leased") throw new HttpError(409, `job is ${job.status}; not publishing`);
    if (body.verification?.verified !== true) throw new HttpError(422, "only a change the companion verified is published");
    if (!job.repairable || job.headRef.startsWith(FIX_BRANCH_PREFIX)) throw new HttpError(403, "this pull request may not be repaired");
    if (!body.files?.length) throw new HttpError(422, "no files");
    const pr = await this.gh<any>(job, "GET", `/repos/${job.repo}/pulls/${job.prNumber}`);
    if (pr.state !== "open") throw new HttpError(409, "the pull request is no longer open");
    if (pr.head.sha !== job.headSha) {
      this.store.update(job, { status: "superseded", supersededBy: pr.head.sha });
      throw new HttpError(409, `the pull request moved to ${pr.head.sha.slice(0, 8)}; the fix for ${job.headSha.slice(0, 8)} is stale and was not published`);
    }
    const base = await this.gh<{ tree: { sha: string } }>(job, "GET", `/repos/${job.repo}/git/commits/${job.headSha}`);
    const tree: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
    for (const f of body.files) {
      if (f.path.startsWith("/") || f.path.split("/").includes("..") || f.path.split("/").includes(".git")) throw new HttpError(422, `invalid path ${f.path}`);
      if (f.after === null) tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      else {
        const blob = await this.gh<{ sha: string }>(job, "POST", `/repos/${job.repo}/git/blobs`, { content: Buffer.from(f.after).toString("base64"), encoding: "base64" });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      }
    }
    const newTree = await this.gh<{ sha: string }>(job, "POST", `/repos/${job.repo}/git/trees`, { base_tree: base.tree.sha, tree });
    const commit = await this.gh<{ sha: string }>(job, "POST", `/repos/${job.repo}/git/commits`, {
      message: `${body.title}\n\nVerified by Crashpad against ${job.baseRef}.\nCrashpad-Repair: ${body.repairId}`,
      tree: newTree.sha,
      parents: [job.headSha],
    });
    const safe = job.headRef.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
    const branch = `${FIX_BRANCH_PREFIX}${safe}-${job.headSha.slice(0, 8)}`;
    try {
      await this.gh(job, "POST", `/repos/${job.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    } catch (err) {
      if (err instanceof GitHubHttpError && err.status === 422) throw new HttpError(409, `branch ${branch} already exists; refusing to overwrite it (no force pushes)`);
      throw err;
    }
    let prUrl: string | null = null;
    let message: string;
    try {
      const created = await this.gh<{ number: number; html_url: string }>(job, "POST", `/repos/${job.repo}/pulls`, { title: body.title, body: body.body, head: branch, base: job.headRef, draft: true });
      prUrl = created.html_url;
      message = `opened draft PR #${created.number}`;
    } catch (err) {
      message = `branch ${branch} was created (commit ${commit.sha.slice(0, 12)}) but opening the pull request failed: ${(err as Error).message}`;
    }
    this.log(`repair ${job.id}: ${message}`);
    return { branch, commit: commit.sha, prUrl, message };
  }

  heartbeat(c: Companion, body: { version?: string; claude?: { ready: boolean; message: string } }): object {
    const wasOnline = this.store.companions().some((x) => x.id === c.id && x.lastSeen && Date.now() - Date.parse(x.lastSeen) < this.cfg.onlineWindowMs);
    this.store.touchCompanion(c, { ...(body.version ? { version: body.version } : {}), ...(body.claude ? { claude: { ready: !!body.claude.ready, message: String(body.claude.message).slice(0, 300) } } : {}) });
    if (!wasOnline) void this.refreshQueued();
    return { ok: true, serverTime: new Date().toISOString(), onlineWindowMs: this.cfg.onlineWindowMs };
  }

  /** Update queued check runs so their text matches the companion's real presence. */
  async refreshQueued(): Promise<void> {
    for (const j of this.store.jobs()) {
      if (j.status !== "queued") continue;
      await this.updateCheckRun(j, { status: "queued", output: this.presenceText(j.installationId) }).catch(() => {});
    }
  }

  /** A short-lived, read-only token for one repository (onboarding discovery on the companion). */
  async readToken(c: Companion, repo: string): Promise<object> {
    const id = c.installations.find((i) => this.store.repoAllowed(i, repo));
    if (id === undefined) throw new HttpError(403, `${repo} is not in an installation this companion can access`);
    const t = await this.app.installationToken(id, { repositories: [repo.split("/")[1]!], permissions: { contents: "read", metadata: "read" } });
    return { token: t.token, expiresAt: t.expiresAt, cloneUrl: `${this.cfg.webUrl.replace(/\/$/, "")}/${repo}.git` };
  }

  repos(c: Companion): object {
    return c.installations.flatMap((id) => {
      const i = this.store.installation(id);
      return i ? i.repositories.map((r) => ({ repo: r, installation: id, account: i.account, selection: i.repositorySelection, policy: this.repoPolicy(r) })) : [];
    });
  }

  setPolicy(c: Companion, repo: string, p: Partial<RepairPolicy>): object {
    const id = c.installations.find((i) => this.store.repoAllowed(i, repo));
    if (id === undefined) throw new HttpError(403, `${repo} is not in an installation this companion can access`);
    const next = { ...this.repoPolicy(repo), ...(p.autoRepair !== undefined ? { autoRepair: !!p.autoRepair } : {}), ...(p.maxRepairsPerPr !== undefined ? { maxRepairsPerPr: Math.max(0, Math.min(10, Number(p.maxRepairsPerPr))) } : {}) };
    this.store.setPolicy(repo, { repair: next });
    return { repo: repo.toLowerCase(), repair: next };
  }

  status(c: Companion): object {
    return {
      companion: { id: c.id, name: c.name, login: c.login, installations: c.installations },
      online: this.store.companions().filter((x) => !x.revoked && x.installations.some((i) => c.installations.includes(i))).map((x) => ({ name: x.name, lastSeen: x.lastSeen, online: !!x.lastSeen && Date.now() - Date.parse(x.lastSeen) < this.cfg.onlineWindowMs, claude: x.claude })),
      jobs: this.store.jobs().filter((j) => c.installations.includes(j.installationId)).slice(-50).map((j) => ({ id: j.id, kind: j.kind, repo: j.repo, pr: j.prNumber, sha: j.headSha.slice(0, 12), status: j.status, result: j.result })),
    };
  }

  // ---------------------------------------------------------------- HTTP

  async route(req: http.IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? "/", "http://service");
    const p = url.pathname;
    if (req.method === "GET" && p === "/healthz") {
      // Healthy = configured and able to persist state. No secrets or repository names.
      const storage = this.store.writable();
      return { status: storage ? 200 : 503, body: { ok: storage, version: VERSION, storage: storage ? "ok" : "not writable", companionsOnline: this.store.companions().filter((c) => !c.revoked && c.lastSeen && Date.now() - Date.parse(c.lastSeen) < this.cfg.onlineWindowMs).length } };
    }
    if (req.method === "GET" && p === "/api/app") return { status: 200, body: { appId: this.cfg.appId, clientId: this.cfg.clientId ?? null, slug: this.cfg.appSlug ?? null, installUrl: this.cfg.appSlug ? `${this.cfg.webUrl}/apps/${this.cfg.appSlug}/installations/new` : null } };
    if (req.method === "POST" && p === "/github/webhook") {
      const raw = await readBody(req);
      if (!verifySignature(this.cfg.webhookSecret, raw, req.headers["x-hub-signature-256"] as string | undefined)) return { status: 401, body: { error: "invalid webhook signature" } };
      if (this.store.seenDelivery(req.headers["x-github-delivery"] as string | undefined)) return { status: 200, body: { duplicate: true } };
      return this.handleWebhook(String(req.headers["x-github-event"] ?? ""), JSON.parse(raw.toString("utf8")));
    }
    if (req.method === "POST" && p === "/api/companions/register") return { status: 200, body: await this.register(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}")) };
    if (!p.startsWith("/api/companion/")) return { status: 404, body: { error: "not found" } };
    const auth = String(req.headers.authorization ?? "");
    const c = auth.startsWith("Bearer ") ? this.store.companionByToken(auth.slice(7)) : null;
    if (!c) return { status: 401, body: { error: "invalid or revoked companion token" } };
    const body = req.method === "POST" || req.method === "PUT" ? JSON.parse((await readBody(req)).toString("utf8") || "{}") : {};
    let m: RegExpMatchArray | null;
    if (req.method === "POST" && p === "/api/companion/heartbeat") return { status: 200, body: this.heartbeat(c, body) };
    if (req.method === "POST" && p === "/api/companion/jobs/lease") {
      this.store.touchCompanion(c, {});
      const job = await this.lease(c, Number(body.waitMs ?? 0));
      return job ? { status: 200, body: job } : { status: 204, body: null };
    }
    if (req.method === "POST" && (m = p.match(/^\/api\/companion\/jobs\/([0-9a-f]+)\/progress$/))) return { status: 200, body: this.progress(c, m[1]!) };
    if (req.method === "POST" && (m = p.match(/^\/api\/companion\/jobs\/([0-9a-f]+)\/complete$/))) return { status: 200, body: await this.complete(c, m[1]!, body) };
    if (req.method === "POST" && (m = p.match(/^\/api\/companion\/jobs\/([0-9a-f]+)\/fix$/))) return { status: 200, body: await this.publishFix(c, m[1]!, body) };
    if (req.method === "GET" && p === "/api/companion/repos") return { status: 200, body: this.repos(c) };
    if (req.method === "POST" && p === "/api/companion/token") return { status: 200, body: await this.readToken(c, String(body.repo ?? "")) };
    if (req.method === "GET" && p === "/api/companion/status") return { status: 200, body: this.status(c) };
    if (req.method === "PUT" && (m = p.match(/^\/api\/companion\/policy\/([^/]+)\/([^/]+)$/))) return { status: 200, body: this.setPolicy(c, `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`, body) };
    return { status: 404, body: { error: "not found" } };
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    this.server = http.createServer((req, res) => {
      this.route(req)
        .then((r) => {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(r.body === null ? "" : JSON.stringify(r.body));
        })
        .catch((err) => {
          const status = err instanceof HttpError ? err.status : 500;
          if (status === 500) this.log(`error: ${(err as Error).stack ?? err}`);
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: status === 500 ? "internal error" : (err as Error).message }));
        });
    });
    this.sweeper = setInterval(() => void this.refreshQueued(), 30_000);
    this.sweeper.unref();
    return new Promise((resolve) => this.server!.listen(port, host, () => resolve((this.server!.address() as { port: number }).port)));
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.events.emit("job");
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
