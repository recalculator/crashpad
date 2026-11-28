import { createVerify, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * A FAKE GitHub (REST API + OAuth device flow) for testing the Crashpad GitHub App
 * service and companion locally. It is test infrastructure only:
 * - App JWTs are verified with the App's public key (RS256, iss, exp), and
 *   installation tokens are scoped to the repositories requested;
 * - check runs, pull requests, and permissions are recorded in memory;
 * - the Git Data API (blobs, trees, commits, refs) is implemented with git
 *   plumbing on a REAL bare repository, so published fix commits are real.
 * It does not prove the live GitHub integration works.
 */

export interface FakeCheckRun {
  id: number;
  repo: string;
  name: string;
  head_sha: string;
  status: string;
  conclusion?: string;
  output?: { title: string; summary: string; annotations?: unknown[] };
  actions?: Array<{ label: string; identifier: string }>;
  annotations: unknown[];
  history: Array<Record<string, unknown>>;
}

export class FakeGitHubServer {
  readonly appId = "424242";
  readonly clientId = "Iv1.fakeclient";
  readonly slug = "crashpad-test";
  /** One-time codes accepted by the manifest conversion endpoint, and the key it returns. */
  manifestCodes = new Set<string>();
  manifestPem = "";
  private publicKey: string;
  private server: http.Server | null = null;
  url = "";
  tokens = new Map<string, { installationId: number; repositories: string[] | null; permissions: Record<string, string> }>();
  users = new Map<string, { id: number; login: string; installations: number[] }>();
  checkRuns: FakeCheckRun[] = [];
  pulls: Array<{ repo: string; number: number; title: string; body: string; head: string; base: string; draft: boolean }> = [];
  /** repo → PR number → current head sha/state (what GET /pulls/:n returns). */
  prState = new Map<string, { head: { sha: string; ref: string; repo: { full_name: string } }; base: { sha: string; ref: string; repo: { full_name: string } }; state: string }>();
  permissions = new Map<string, string>();
  bareRepos = new Map<string, string>();
  deviceApproved = new Map<string, string>();
  requests: string[] = [];

  constructor(publicKeyPem: string) {
    this.publicKey = publicKeyPem;
  }

  private verifyJwt(auth: string | undefined): boolean {
    const t = auth?.replace(/^Bearer /, "") ?? "";
    const [h, p, s] = t.split(".");
    if (!h || !p || !s) return false;
    if (!createVerify("RSA-SHA256").update(`${h}.${p}`).verify(this.publicKey, Buffer.from(s, "base64url"))) return false;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    return claims.iss === this.appId && claims.exp > now && claims.iat <= now && claims.exp - claims.iat <= 600;
  }

  private git(repo: string, args: string[], input?: string | Buffer, env: NodeJS.ProcessEnv = {}): string {
    return execFileSync("git", args, { cwd: this.bareRepos.get(repo)!, input, env: { ...process.env, GIT_AUTHOR_NAME: "crashpad-test[bot]", GIT_AUTHOR_EMAIL: "bot@example.test", GIT_COMMITTER_NAME: "crashpad-test[bot]", GIT_COMMITTER_EMAIL: "bot@example.test", ...env }, encoding: "utf8" }).trim();
  }

  async handle(req: http.IncomingMessage, body: any): Promise<[number, unknown]> {
    const url = new URL(req.url!, "http://fake");
    const p = url.pathname;
    const auth = req.headers.authorization;
    this.requests.push(`${req.method} ${p}`);
    let m: RegExpMatchArray | null;

    // App manifest registration: a one-time code becomes the App's credentials.
    if (req.method === "POST" && (m = p.match(/^\/app-manifests\/([^/]+)\/conversions$/))) {
      if (!this.manifestCodes.has(m[1]!)) return [404, { message: "Not Found" }];
      this.manifestCodes.delete(m[1]!);
      return [201, { id: Number(this.appId), slug: this.slug, client_id: this.clientId, client_secret: "fake-secret", webhook_secret: "fake-webhook-secret-0123456789abcdef0123", pem: this.manifestPem, html_url: `https://github.com/apps/${this.slug}` }];
    }
    if (req.method === "GET" && p === "/app") return this.verifyJwt(auth) ? [200, { slug: this.slug, client_id: this.clientId }] : [401, { message: "Bad credentials" }];
    if (req.method === "POST" && (m = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      if (!this.verifyJwt(auth)) return [401, { message: "A JSON web token could not be decoded" }];
      const token = `ghs_fake_${randomBytes(8).toString("hex")}`;
      this.tokens.set(token, { installationId: Number(m[1]), repositories: body?.repositories ?? null, permissions: body?.permissions ?? {} });
      return [201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() }];
    }
    // ---- OAuth device flow (the user "approves" by the test calling approveDevice)
    if (req.method === "POST" && p === "/login/device/code") {
      if (body.client_id !== this.clientId) return [200, { error: "incorrect_client_credentials" }];
      const device_code = randomBytes(8).toString("hex");
      return [200, { device_code, user_code: "ABCD-1234", verification_uri: `${this.url}/login/device`, expires_in: 900, interval: 0.05 }];
    }
    if (req.method === "POST" && p === "/login/oauth/access_token") {
      const login = this.deviceApproved.get("next");
      if (!login) return [200, { error: "authorization_pending" }];
      const token = `ghu_fake_${randomBytes(8).toString("hex")}`;
      const u = this.users.get(login)!;
      this.users.set(token, u);
      return [200, { access_token: token, token_type: "bearer" }];
    }
    if (req.method === "GET" && (p === "/user" || p === "/user/installations")) {
      const u = this.users.get(auth?.replace(/^Bearer /, "") ?? "");
      if (!u) return [401, { message: "Bad credentials" }];
      return p === "/user" ? [200, { id: u.id, login: u.login }] : [200, { total_count: u.installations.length, installations: u.installations.map((id) => ({ id, app_id: Number(this.appId) })) }];
    }

    // ---- Installation-token endpoints
    const tok = this.tokens.get(auth?.replace(/^Bearer /, "") ?? "");
    if (!tok) return [401, { message: "Bad credentials" }];
    m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)$/);
    if (!m) return [404, { message: "Not Found" }];
    const repo = `${m[1]}/${m[2]}`;
    const rest = m[3]!;
    if (tok.repositories && !tok.repositories.includes(m[2]!)) return [403, { message: "Resource not accessible by integration (token scoped to other repositories)" }];
    if (req.method === "POST" && rest === "/check-runs") {
      const run: FakeCheckRun = { id: this.checkRuns.length + 1, repo, name: body.name, head_sha: body.head_sha, status: body.status ?? "queued", ...(body.conclusion ? { conclusion: body.conclusion } : {}), ...(body.output ? { output: body.output } : {}), ...(body.actions ? { actions: body.actions } : {}), annotations: body.output?.annotations ?? [], history: [body] };
      this.checkRuns.push(run);
      return [201, { id: run.id }];
    }
    if (req.method === "PATCH" && (m = rest.match(/^\/check-runs\/(\d+)$/))) {
      const run = this.checkRuns.find((r) => r.id === Number(m![1]));
      if (!run) return [404, { message: "Not Found" }];
      run.history.push(body);
      if (body.status) run.status = body.status;
      if (body.conclusion) run.conclusion = body.conclusion;
      if (body.output) {
        run.output = body.output;
        run.annotations.push(...(body.output.annotations ?? []));
      }
      if (body.actions) run.actions = body.actions;
      return [200, { id: run.id }];
    }
    if (req.method === "GET" && (m = rest.match(/^\/pulls\/(\d+)$/))) {
      const s = this.prState.get(`${repo}#${m[1]}`);
      return s ? [200, { number: Number(m[1]), ...s }] : [404, { message: "Not Found" }];
    }
    if (req.method === "POST" && rest === "/pulls") {
      const n = 100 + this.pulls.length;
      this.pulls.push({ repo, number: n, title: body.title, body: body.body, head: body.head, base: body.base, draft: body.draft });
      return [201, { number: n, html_url: `https://github.example/${repo}/pull/${n}` }];
    }
    if (req.method === "GET" && (m = rest.match(/^\/collaborators\/([^/]+)\/permission$/))) return [200, { permission: this.permissions.get(decodeURIComponent(m[1]!)) ?? "none" }];
    if (rest.startsWith("/git/") && !tok.permissions.contents && tok.repositories) return [403, { message: "Resource not accessible by integration" }];
    if (req.method === "GET" && (m = rest.match(/^\/git\/commits\/([0-9a-f]{40})$/))) return [200, { sha: m[1], tree: { sha: this.git(repo, ["rev-parse", `${m[1]}^{tree}`]) } }];
    if (req.method === "POST" && rest === "/git/blobs") return [201, { sha: this.git(repo, ["hash-object", "-w", "--stdin"], Buffer.from(body.content, "base64")) }];
    if (req.method === "POST" && rest === "/git/trees") {
      const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fakegh-")), "index");
      const env = { GIT_INDEX_FILE: index };
      this.git(repo, ["read-tree", body.base_tree], undefined, env);
      for (const e of body.tree) {
        if (e.sha === null) this.git(repo, ["update-index", "--force-remove", "--", e.path], undefined, env);
        else this.git(repo, ["update-index", "--add", "--cacheinfo", `${e.mode},${e.sha},${e.path}`], undefined, env);
      }
      return [201, { sha: this.git(repo, ["write-tree"], undefined, env) }];
    }
    if (req.method === "POST" && rest === "/git/commits") return [201, { sha: this.git(repo, ["commit-tree", body.tree, ...body.parents.flatMap((x: string) => ["-p", x]), "-m", body.message]) }];
    if (req.method === "POST" && rest === "/git/refs") {
      const exists = (() => {
        try {
          this.git(repo, ["rev-parse", "--verify", "--quiet", body.ref]);
          return true;
        } catch {
          return false;
        }
      })();
      if (exists) return [422, { message: "Reference already exists" }];
      this.git(repo, ["update-ref", body.ref, body.sha]);
      return [201, { ref: body.ref, object: { sha: body.sha } }];
    }
    return [404, { message: `fake GitHub does not implement ${req.method} ${p}` }];
  }

  async start(): Promise<string> {
    this.server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
      try {
        const [status, out] = await this.handle(req, body);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: (err as Error).message }));
      }
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server!.address() as { port: number }).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  run(name: string, headSha?: string): FakeCheckRun | undefined {
    return this.checkRuns.filter((r) => r.name === name && (!headSha || r.head_sha === headSha)).at(-1);
  }
}
