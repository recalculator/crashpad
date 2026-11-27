import fs from "node:fs/promises";
import path from "node:path";
import { crashpadHome } from "../discovery/store.ts";

/**
 * The companion's local settings (CRASHPAD_HOME/companion.json, mode 600). The
 * companion token authenticates this machine to the Crashpad service; it is not a
 * GitHub token and has nothing to do with Claude Code's sign-in.
 */
export interface CompanionConfig {
  service: string;
  token: string;
  companionId: string;
  login: string;
  name: string;
  repair: {
    /** Repairs use the owner's Claude usage, so they run only if the owner turns them on here. */
    enabled: boolean;
    maxAttempts: number;
    maxTurns: number;
    maxBudgetUsd?: number;
    deadlineMin: number;
    claudeAuth: "subscription" | "existing";
  };
  databaseUrl?: string;
}

export function companionFile(): string {
  return path.join(crashpadHome(), "companion.json");
}

export async function loadCompanionConfig(): Promise<CompanionConfig | null> {
  try {
    return JSON.parse(await fs.readFile(companionFile(), "utf8")) as CompanionConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveCompanionConfig(c: CompanionConfig): Promise<void> {
  await fs.mkdir(path.dirname(companionFile()), { recursive: true, mode: 0o700 });
  const tmp = `${companionFile()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, companionFile());
}

export class ServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LeasedJob {
  id: string;
  kind: "check" | "repair";
  repo: string;
  cloneUrl: string;
  token: string;
  tokenExpiresAt: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  repairable: boolean;
  leaseMs: number;
}

export class ServiceClient {
  readonly base: string;
  private token: string | null;
  constructor(base: string, token: string | null) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
  }

  async call<T>(method: string, p: string, body?: unknown, timeoutMs = 60_000): Promise<T | null> {
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), "user-agent": "crashpad-companion" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.status === 204) return null;
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: text };
    }
    if (!res.ok) throw new ServiceError(res.status, json?.error ?? json?.refused ?? `HTTP ${res.status}`);
    return json as T;
  }

  app() {
    return this.call<{ appId: string; clientId: string | null; slug: string | null; installUrl: string | null }>("GET", "/api/app");
  }
  register(githubToken: string, name: string) {
    return this.call<{ token: string; companion: { id: string; login: string; installations: number[] } }>("POST", "/api/companions/register", { githubToken, name });
  }
  heartbeat(body: object) {
    return this.call<{ ok: boolean }>("POST", "/api/companion/heartbeat", body);
  }
  lease(waitMs: number) {
    return this.call<LeasedJob>("POST", "/api/companion/jobs/lease", { waitMs }, waitMs + 30_000);
  }
  progress(id: string) {
    return this.call<{ cancel: boolean; status: string }>("POST", `/api/companion/jobs/${id}/progress`, {});
  }
  complete(id: string, body: object) {
    return this.call<{ ok: boolean; conclusion: string; repair: string | null }>("POST", `/api/companion/jobs/${id}/complete`, body);
  }
  fix(id: string, body: object) {
    return this.call<{ branch: string; commit: string; prUrl: string | null; message: string }>("POST", `/api/companion/jobs/${id}/fix`, body);
  }
  repos() {
    return this.call<Array<{ repo: string; installation: number; account: string; selection: string; policy: { autoRepair: boolean; maxRepairsPerPr: number } }>>("GET", "/api/companion/repos");
  }
  status() {
    return this.call<any>("GET", "/api/companion/status");
  }
  setPolicy(repo: string, p: object) {
    const [o, r] = repo.split("/");
    return this.call<object>("PUT", `/api/companion/policy/${encodeURIComponent(o!)}/${encodeURIComponent(r!)}`, p);
  }
}

/**
 * GitHub's OAuth device flow for the Crashpad GitHub App (the App must have
 * "Enable Device Flow" turned on). The resulting user token is sent once to the
 * service, which uses it only to confirm which installations the user can access,
 * and it is not saved anywhere.
 */
export async function deviceFlow(opts: { githubUrl: string; clientId: string; onCode: (c: { userCode: string; verificationUri: string; expiresIn: number }) => void; signal?: AbortSignal }): Promise<string> {
  const post = async (p: string, body: Record<string, string>) => {
    const res = await fetch(`${opts.githubUrl.replace(/\/$/, "")}${p}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as Record<string, any>;
  };
  const code = await post("/login/device/code", { client_id: opts.clientId });
  if (!code.device_code) throw new Error(`GitHub did not start the device flow: ${code.error_description ?? code.error ?? "unknown error"} (is "Enable Device Flow" on for the App?)`);
  opts.onCode({ userCode: code.user_code, verificationUri: code.verification_uri, expiresIn: code.expires_in });
  let interval = Number(code.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(code.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    await new Promise((r) => setTimeout(r, interval));
    const t = await post("/login/oauth/access_token", { client_id: opts.clientId, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    if (t.access_token) return t.access_token as string;
    if (t.error === "authorization_pending") continue;
    if (t.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new Error(`GitHub sign-in failed: ${t.error_description ?? t.error}`);
  }
  throw new Error("the device code expired before it was approved");
}
