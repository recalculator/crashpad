import { createSign } from "node:crypto";
import { GitHubHttpError } from "../github/client.ts";

/**
 * GitHub App authentication, as documented by GitHub:
 * - the App signs a short-lived JWT (RS256, iss = App ID) with its private key;
 * - it exchanges the JWT for an installation access token, scoped to specific
 *   repositories and permissions, valid for at most an hour.
 * These are the App's credentials. They never leave the service and are
 * unrelated to anyone's Claude Code sign-in.
 */

export interface AppCredentials {
  appId: string;
  privateKeyPem: string;
  /** e.g. https://api.github.com (tests point this at a fake). */
  apiUrl: string;
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64url");
}

export function appJwt(c: AppCredentials, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdate iat to tolerate clock drift; GitHub allows at most 10 minutes of validity.
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: c.appId }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(c.privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
}

async function call<T>(apiUrl: string, auth: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: auth,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "crashpad-service",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* raw */
    }
    throw new GitHubHttpError(res.status, `GitHub API ${method} ${path} failed (${res.status}): ${msg}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export class GitHubApp {
  readonly creds: AppCredentials;
  private cache = new Map<string, InstallationToken>();
  constructor(creds: AppCredentials) {
    this.creds = creds;
  }

  async app(): Promise<{ slug: string; client_id?: string; html_url?: string }> {
    return call(this.creds.apiUrl, `Bearer ${appJwt(this.creds)}`, "GET", "/app");
  }

  /** An installation token, optionally narrowed to repositories and permissions. */
  async installationToken(installationId: number, scope?: { repositories?: string[]; permissions?: Record<string, "read" | "write"> }): Promise<InstallationToken> {
    const key = `${installationId}:${JSON.stringify(scope ?? {})}`;
    const hit = this.cache.get(key);
    if (hit && Date.parse(hit.expiresAt) - Date.now() > 5 * 60_000) return hit;
    const r = await call<{ token: string; expires_at: string }>(this.creds.apiUrl, `Bearer ${appJwt(this.creds)}`, "POST", `/app/installations/${installationId}/access_tokens`, scope ?? {});
    const t = { token: r.token, expiresAt: r.expires_at };
    this.cache.set(key, t);
    return t;
  }

  async asInstallation<T>(installationId: number, method: string, path: string, body?: unknown): Promise<T> {
    const t = await this.installationToken(installationId);
    return call<T>(this.creds.apiUrl, `Bearer ${t.token}`, method, path, body);
  }
}

/** Calls made with a GitHub user access token (from the device flow), only to verify a pairing. */
export async function asUser<T>(apiUrl: string, userToken: string, method: string, path: string): Promise<T> {
  return call<T>(apiUrl, `Bearer ${userToken}`, method, path);
}
