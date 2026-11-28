import fs from "node:fs/promises";
import os from "node:os";
import { UsageError, type Values } from "../cli.ts";
import { databaseUrl } from "../context.ts";
import { deviceFlow, loadCompanionConfig, saveCompanionConfig, ServiceClient, type CompanionConfig } from "../companion/client.ts";
import { runCompanion } from "../companion/worker.ts";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { CrashpadService } from "../service/server.ts";
import { checkServiceConfig, convertManifestCode, renderConfigCheck, REQUIRED_EVENTS, REQUIRED_PERMISSIONS } from "../service/config.ts";

const log = (m: string) => process.stderr.write(`crashpad: ${m}\n`);

/** Pair this machine with a Crashpad service using GitHub's device flow. */
export async function connectCompanion(opts: { service: string; githubUrl?: string; name?: string; onCode?: (c: { userCode: string; verificationUri: string }) => void; repair?: Partial<CompanionConfig["repair"]> }): Promise<CompanionConfig> {
  const client = new ServiceClient(opts.service, null);
  const app = await client.app();
  if (!app?.clientId) throw new Error("the service does not advertise a GitHub App client id (set CRASHPAD_GITHUB_CLIENT_ID on the service)");
  const githubToken = await deviceFlow({
    githubUrl: opts.githubUrl ?? "https://github.com",
    clientId: app.clientId,
    onCode: opts.onCode ?? ((c) => process.stdout.write(`To connect this computer, open ${c.verificationUri} and enter the code ${c.userCode}\n`)),
  });
  const name = opts.name ?? os.hostname();
  const r = (await client.register(githubToken, name))!;
  const cfg: CompanionConfig = {
    service: opts.service,
    token: r.token,
    companionId: r.companion.id,
    login: r.companion.login,
    name,
    repair: { enabled: false, maxAttempts: 2, maxTurns: 40, deadlineMin: 30, claudeAuth: "subscription", ...opts.repair },
  };
  await saveCompanionConfig(cfg);
  return cfg;
}

export async function cmdConnect(v: Values): Promise<number> {
  if (!v.service) throw new UsageError("--service <url> is required (the Crashpad GitHub App service)");
  const cfg = await connectCompanion({ service: v.service, ...(v.name ? { name: v.name } : {}), ...(process.env.CRASHPAD_GITHUB_URL ? { githubUrl: process.env.CRASHPAD_GITHUB_URL } : {}) });
  process.stdout.write(`connected as ${cfg.login} (companion ${cfg.companionId}, "${cfg.name}"). Repairs are OFF until you run: crashpad companion --enable-repair\n`);
  return 0;
}

export async function cmdCompanion(v: Values): Promise<number> {
  const cfg = await loadCompanionConfig();
  if (!cfg) {
    process.stderr.write("crashpad: this computer is not connected. Run: crashpad connect --service <url>\n");
    return 2;
  }
  const sub = v._sub;
  if (v["enable-repair"] || v["disable-repair"]) {
    cfg.repair.enabled = !!v["enable-repair"];
    if (v["max-attempts"]) cfg.repair.maxAttempts = Number(v["max-attempts"]);
    if (v["max-turns"]) cfg.repair.maxTurns = Number(v["max-turns"]);
    if (v["max-budget-usd"]) cfg.repair.maxBudgetUsd = Number(v["max-budget-usd"]);
    if (v["claude-auth"]) cfg.repair.claudeAuth = v["claude-auth"] as "subscription" | "existing";
    await saveCompanionConfig(cfg);
    process.stdout.write(`repairs ${cfg.repair.enabled ? "enabled" : "disabled"} on this companion\n`);
    if (!sub) return 0;
  }
  const client = new ServiceClient(cfg.service, cfg.token);
  if (sub === "status") {
    process.stdout.write(JSON.stringify(await client.status(), null, 2) + "\n");
    return 0;
  }
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  log(`companion "${cfg.name}" for ${cfg.login} → ${cfg.service} (repairs ${cfg.repair.enabled ? "on" : "off"})`);
  const handled = await runCompanion({ client, config: cfg, databaseUrl: databaseUrl(v["database-url"] ?? cfg.databaseUrl), log, signal: controller.signal, once: !!v.once });
  for (const h of handled) log(`job ${h.job}: ${h.status}`);
  return 0;
}

export async function cmdPolicy(v: Values): Promise<number> {
  const cfg = await loadCompanionConfig();
  if (!cfg) throw new UsageError("not connected; run crashpad connect first");
  if (!v.repo) throw new UsageError("--repo owner/name is required");
  const client = new ServiceClient(cfg.service, cfg.token);
  const body: Record<string, unknown> = {};
  if (v["auto-repair"] !== undefined) body.autoRepair = v["auto-repair"] === "on";
  if (v["max-repairs"] !== undefined) body.maxRepairsPerPr = Number(v["max-repairs"]);
  process.stdout.write(JSON.stringify(await client.setPolicy(v.repo, body), null, 2) + "\n");
  return 0;
}

/** Run the GitHub App service from environment variables. */
export async function cmdService(v: Values): Promise<number> {
  const env = process.env;
  if (v._sub === "manifest") {
    const url = v.url ?? env.CRASHPAD_PUBLIC_URL;
    if (!url) throw new UsageError("--url <public service URL> is required");
    process.stdout.write(JSON.stringify(appManifest(url), null, 2) + "\n");
    return 0;
  }
  if (v._sub === "check") {
    const r = await checkServiceConfig(env, { online: !!v.online });
    process.stdout.write(renderConfigCheck(r));
    return r.ok ? 0 : 2;
  }
  if (v._sub === "register") return cmdRegister(v);
  // The same validation as `crashpad service check`: never start half-configured.
  const checked = await checkServiceConfig(env);
  if (!checked.ok) {
    process.stderr.write(renderConfigCheck(checked));
    return 2;
  }
  for (const i of checked.items.filter((x) => x.level === "warn")) log(`warning: ${i.message}`);
  const svc = new CrashpadService({ ...checked.config!, log });
  const port = await svc.listen(Number(v.port ?? env.PORT ?? 8787), v.host ?? env.HOST ?? "127.0.0.1");
  log(`service listening on port ${port}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await svc.close();
  return 0;
}

/** GitHub App manifest (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). */
export function appManifest(publicUrl: string, opts: { redirectUrl?: string; name?: string } = {}): Record<string, unknown> {
  const base = publicUrl.replace(/\/$/, "");
  if (!/^https:\/\//.test(base)) throw new UsageError("the service URL must be https:// (GitHub delivers webhooks only to a public HTTPS URL)");
  return {
    name: opts.name ?? "Crashpad",
    url: base,
    description: "Runs Crashpad checks on pull requests on the owner's own computer, and opens draft repair PRs only after independent verification.",
    hook_attributes: { url: `${base}/github/webhook`, active: true },
    ...(opts.redirectUrl ? { redirect_url: opts.redirectUrl } : {}),
    public: false,
    request_oauth_on_install: false,
    default_permissions: { ...REQUIRED_PERMISSIONS },
    default_events: [...REQUIRED_EVENTS],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Register the App from its manifest without copying secrets by hand: a one-shot local
 * page posts the manifest to GitHub, GitHub redirects back to localhost with a one-time
 * code, and the code is exchanged for the App's credentials, written to --out (mode 600).
 * Nothing is sent anywhere except GitHub.
 */
async function cmdRegister(v: Values): Promise<number> {
  const url = v.url ?? process.env.CRASHPAD_PUBLIC_URL;
  if (!url) throw new UsageError("--url <public service URL> is required (for example https://crashpad.example.com)");
  const out = v.out ?? "crashpad-app-credentials";
  const port = Number(v.port ?? 3999);
  const web = (process.env.CRASHPAD_GITHUB_URL ?? "https://github.com").replace(/\/$/, "");
  const target = v.org ? `${web}/organizations/${encodeURIComponent(v.org)}/settings/apps/new` : `${web}/settings/apps/new`;
  const state = randomBytes(16).toString("hex");
  const redirect = `http://localhost:${port}/callback`;
  const manifest = appManifest(url, { redirectUrl: redirect, ...(v.name ? { name: v.name } : {}) });
  const result = await new Promise<number>((resolve) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (u.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Register Crashpad</title><p>Sending the Crashpad App manifest to GitHub…</p><form id="f" method="post" action="${escapeHtml(target)}?state=${state}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form><script>document.getElementById("f").submit()</script>`);
        return;
      }
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) {
        res.writeHead(400, { "content-type": "text/plain" }).end("Unexpected request (state mismatch or no code). Nothing was saved.");
        return;
      }
      try {
        const r = await convertManifestCode({ code: u.searchParams.get("code")!, outDir: out, ...(process.env.CRASHPAD_GITHUB_API_URL ? { apiUrl: process.env.CRASHPAD_GITHUB_API_URL } : {}) });
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(`Registered ${r.slug} (App ID ${r.appId}). Credentials were saved on your computer; return to the terminal.`);
        process.stdout.write(
          `Registered the GitHub App ${r.slug} (App ID ${r.appId})${r.htmlUrl ? `: ${r.htmlUrl}` : ""}\n` +
            `  private key:      ${r.keyFile}  (mode 600)\n` +
            `  service settings: ${r.envFile}  (mode 600)\n` +
            `Next: in the App's settings, turn on "Enable Device Flow". Then copy both files to the host (see deploy/README.md).\n`,
        );
        server.close();
        resolve(0);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" }).end(`Registration could not be completed: ${(err as Error).message}`);
        process.stderr.write(`crashpad: ${(err as Error).message}\n`);
        server.close();
        resolve(2);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`Open http://localhost:${port}/ in the browser where you are signed in to GitHub${v.org ? ` (as an owner of ${v.org})` : ""}.\nIt posts the Crashpad App manifest to ${target}; after you confirm, GitHub sends you back here.\n`);
    });
  });
  return result;
}
