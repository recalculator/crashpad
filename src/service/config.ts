import { createPrivateKey } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appJwt } from "./github-app.ts";
import type { ServiceConfig } from "./server.ts";

/**
 * Validation of the GitHub App service's configuration, run by `crashpad service check`
 * and at service startup. Everything here is local except `online`, which asks GitHub
 * (`GET /app` with an App JWT) whether the App ID and private key belong together.
 */

export interface ConfigItem {
  level: "ok" | "warn" | "error";
  message: string;
}

export interface ServiceConfigResult {
  items: ConfigItem[];
  ok: boolean;
  config: ServiceConfig | null;
}

/** Permissions and events the service needs; compared with the registered App when online. */
export const REQUIRED_PERMISSIONS: Record<string, "read" | "write"> = { checks: "write", contents: "write", pull_requests: "write", metadata: "read" };
export const REQUIRED_EVENTS = ["pull_request", "check_run"];

const LEVEL = { read: 1, write: 2 } as Record<string, number>;

export async function checkServiceConfig(env: NodeJS.ProcessEnv, opts: { online?: boolean } = {}): Promise<ServiceConfigResult> {
  const items: ConfigItem[] = [];
  const ok = (message: string) => items.push({ level: "ok", message });
  const warn = (message: string) => items.push({ level: "warn", message });
  const error = (message: string) => items.push({ level: "error", message });

  const appId = env.CRASHPAD_GITHUB_APP_ID ?? "";
  if (!appId) error("CRASHPAD_GITHUB_APP_ID is not set (the App ID from the App's settings page)");
  else if (!/^\d+$/.test(appId)) error(`CRASHPAD_GITHUB_APP_ID must be the numeric App ID, not "${appId}"`);
  else ok(`App ID ${appId}`);

  const clientId = env.CRASHPAD_GITHUB_CLIENT_ID ?? "";
  if (!clientId) error("CRASHPAD_GITHUB_CLIENT_ID is not set: companions pair with the App's device flow and need the client ID");
  else if (!/^(Iv1\.|Iv23)[A-Za-z0-9.]+$/.test(clientId)) warn(`CRASHPAD_GITHUB_CLIENT_ID "${clientId}" does not look like a GitHub App client ID (Iv1.… or Iv23…)`);
  else ok(`client ID ${clientId}`);

  const slug = env.CRASHPAD_GITHUB_APP_SLUG ?? "";
  if (!slug) error("CRASHPAD_GITHUB_APP_SLUG is not set: loop prevention recognizes the App's own commits and PRs by its bot login <slug>[bot]");
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) error(`CRASHPAD_GITHUB_APP_SLUG "${slug}" is not an App slug (lowercase letters, digits, hyphens)`);
  else ok(`App slug ${slug} (bot login ${slug}[bot])`);

  const secret = env.CRASHPAD_GITHUB_WEBHOOK_SECRET ?? "";
  if (!secret) error("CRASHPAD_GITHUB_WEBHOOK_SECRET is not set (the same secret as in the App's webhook settings)");
  else if (secret.length < 32) warn(`the webhook secret is ${secret.length} characters; use at least 32 random characters (openssl rand -hex 32)`);
  else ok(`webhook secret set (${secret.length} characters)`);

  let pem: string | null = null;
  const keyFile = env.CRASHPAD_GITHUB_PRIVATE_KEY_FILE ?? "";
  if (!keyFile) error("CRASHPAD_GITHUB_PRIVATE_KEY_FILE is not set (path to the App's .pem private key)");
  else {
    try {
      const st = await fs.stat(keyFile);
      pem = await fs.readFile(keyFile, "utf8");
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== "rsa") error(`${keyFile} is a ${key.asymmetricKeyType} key; GitHub App keys are RSA`);
      else ok(`private key ${keyFile} (RSA, ${key.asymmetricKeyDetails?.modulusLength ?? "?"} bits)`);
      if (process.platform !== "win32" && st.mode & 0o077) warn(`${keyFile} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
    } catch (err) {
      pem = null;
      error(`cannot use ${keyFile} as the private key: ${(err as Error).message}`);
    }
  }

  const dataFile = env.CRASHPAD_SERVICE_DATA ?? "";
  if (!dataFile) error("CRASHPAD_SERVICE_DATA is not set: the service's state must live on persistent storage (for example /var/lib/crashpad/state.json)");
  else if (!path.isAbsolute(dataFile)) error(`CRASHPAD_SERVICE_DATA must be an absolute path, not "${dataFile}"`);
  else {
    const dir = path.dirname(dataFile);
    if (/^\/(tmp|var\/tmp|private\/tmp|dev\/shm)(\/|$)/.test(dir)) warn(`${dir} is usually cleared on reboot; put the state on persistent storage`);
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const probe = path.join(dir, `.crashpad-write-test-${process.pid}`);
      await fs.writeFile(probe, "ok", { mode: 0o600 });
      await fs.rm(probe, { force: true });
      const existing = await fs.readFile(dataFile, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
      if (existing === null) ok(`state file ${dataFile} (new; the directory is writable)`);
      else {
        const s = JSON.parse(existing) as Record<string, Record<string, unknown>>;
        ok(`state file ${dataFile}: ${Object.keys(s.installations ?? {}).length} installation(s), ${Object.keys(s.companions ?? {}).length} companion(s), ${Object.keys(s.jobs ?? {}).length} job(s)`);
      }
    } catch (err) {
      error(`state file ${dataFile} is not usable: ${(err as Error).message}`);
    }
  }

  const apiUrl = env.CRASHPAD_GITHUB_API_URL ?? "https://api.github.com";
  const webUrl = env.CRASHPAD_GITHUB_URL ?? "https://github.com";
  if (env.CRASHPAD_GITHUB_API_URL || env.CRASHPAD_GITHUB_URL) warn(`not github.com: API ${apiUrl}, web ${webUrl} (only github.com is intended)`);

  if (opts.online && pem && /^\d+$/.test(appId)) {
    try {
      const r = await fetch(`${apiUrl.replace(/\/$/, "")}/app`, { headers: { authorization: `Bearer ${appJwt({ appId, privateKeyPem: pem, apiUrl })}`, accept: "application/vnd.github+json", "user-agent": "crashpad-service" } });
      const body = (await r.json().catch(() => ({}))) as { slug?: string; client_id?: string; permissions?: Record<string, string>; events?: string[]; message?: string };
      if (!r.ok) error(`GitHub rejected the App JWT (${r.status} ${body.message ?? ""}): the App ID and private key do not belong together, or the key was revoked`);
      else {
        ok(`GitHub accepted the App ID and private key (App ${body.slug})`);
        if (slug && body.slug && body.slug !== slug) error(`CRASHPAD_GITHUB_APP_SLUG is ${slug} but the App's slug is ${body.slug}`);
        if (clientId && body.client_id && body.client_id !== clientId) error(`CRASHPAD_GITHUB_CLIENT_ID is ${clientId} but the App's client ID is ${body.client_id}`);
        if (body.permissions) {
          for (const [k, need] of Object.entries(REQUIRED_PERMISSIONS)) {
            const have = body.permissions[k];
            if (!have || (LEVEL[have] ?? 0) < LEVEL[need]!) error(`the App needs ${k}: ${need} (it has ${have ?? "none"})`);
          }
        }
        if (body.events) for (const e of REQUIRED_EVENTS) if (!body.events.includes(e)) error(`the App is not subscribed to the ${e} event`);
      }
    } catch (err) {
      error(`could not reach ${apiUrl}: ${(err as Error).message}`);
    }
  }

  const hasError = items.some((i) => i.level === "error");
  return {
    items,
    ok: !hasError,
    config: hasError
      ? null
      : { appId, privateKeyPem: pem!, webhookSecret: secret, apiUrl, webUrl, clientId, appSlug: slug, dataFile },
  };
}

export function renderConfigCheck(r: ServiceConfigResult): string {
  const icon = { ok: "✓", warn: "!", error: "✗" };
  return [...r.items.map((i) => `${icon[i.level]} ${i.message}`), r.ok ? "Service configuration is valid." : "Service configuration has errors; the service will not start."].join("\n") + "\n";
}

/**
 * Exchange the one-time code GitHub returns after registering an App from a manifest
 * (POST /app-manifests/{code}/conversions) and write the App's credentials:
 * the private key (mode 600) and a service environment file (mode 600). The code expires
 * after one hour and works once.
 */
export async function convertManifestCode(o: { code: string; outDir: string; apiUrl?: string }): Promise<{ keyFile: string; envFile: string; slug: string; appId: string; htmlUrl: string | null }> {
  if (!/^[A-Za-z0-9_-]+$/.test(o.code)) throw new Error("the code must be the value of ?code= from GitHub's redirect");
  const apiUrl = (o.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const r = await fetch(`${apiUrl}/app-manifests/${o.code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "crashpad-service" } });
  const body = (await r.json().catch(() => ({}))) as { id?: number; slug?: string; client_id?: string; webhook_secret?: string; pem?: string; html_url?: string; message?: string };
  if (!r.ok || !body.id || !body.pem || !body.slug || !body.client_id) throw new Error(`GitHub did not convert the code (${r.status} ${body.message ?? ""}); codes work once and expire after an hour`);
  await fs.mkdir(o.outDir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(path.resolve(o.outDir), "app.private-key.pem");
  const envFile = path.join(path.resolve(o.outDir), "service.env");
  for (const f of [keyFile, envFile]) if (await fs.stat(f).catch(() => null)) throw new Error(`${f} already exists; refusing to overwrite App credentials`);
  await fs.writeFile(keyFile, body.pem, { mode: 0o600 });
  const lines = [
    `# Crashpad GitHub App service configuration for ${body.slug} (written by crashpad service register).`,
    "# Paths are the deployment package's host paths (deploy/). Keep this file and the key mode 600.",
    `CRASHPAD_GITHUB_APP_ID=${body.id}`,
    `CRASHPAD_GITHUB_CLIENT_ID=${body.client_id}`,
    `CRASHPAD_GITHUB_APP_SLUG=${body.slug}`,
    "CRASHPAD_GITHUB_PRIVATE_KEY_FILE=/etc/crashpad/app.private-key.pem",
    `CRASHPAD_GITHUB_WEBHOOK_SECRET=${body.webhook_secret ?? ""}`,
    "CRASHPAD_SERVICE_DATA=/var/lib/crashpad/state.json",
    "",
  ];
  await fs.writeFile(envFile, lines.join("\n"), { mode: 0o600 });
  return { keyFile, envFile, slug: body.slug, appId: String(body.id), htmlUrl: body.html_url ?? null };
}
