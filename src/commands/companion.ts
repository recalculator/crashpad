import fs from "node:fs/promises";
import os from "node:os";
import { UsageError, type Values } from "../cli.ts";
import { databaseUrl } from "../context.ts";
import { deviceFlow, loadCompanionConfig, saveCompanionConfig, ServiceClient, type CompanionConfig } from "../companion/client.ts";
import { runCompanion } from "../companion/worker.ts";
import { CrashpadService } from "../service/server.ts";

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
  const keyFile = env.CRASHPAD_GITHUB_PRIVATE_KEY_FILE;
  const missing = ["CRASHPAD_GITHUB_APP_ID", "CRASHPAD_GITHUB_WEBHOOK_SECRET", "CRASHPAD_GITHUB_PRIVATE_KEY_FILE"].filter((k) => !env[k]);
  if (missing.length) throw new UsageError(`missing service settings: ${missing.join(", ")}`);
  const svc = new CrashpadService({
    appId: env.CRASHPAD_GITHUB_APP_ID!,
    privateKeyPem: await fs.readFile(keyFile!, "utf8"),
    webhookSecret: env.CRASHPAD_GITHUB_WEBHOOK_SECRET!,
    apiUrl: env.CRASHPAD_GITHUB_API_URL ?? "https://api.github.com",
    webUrl: env.CRASHPAD_GITHUB_URL ?? "https://github.com",
    ...(env.CRASHPAD_GITHUB_CLIENT_ID ? { clientId: env.CRASHPAD_GITHUB_CLIENT_ID } : {}),
    ...(env.CRASHPAD_GITHUB_APP_SLUG ? { appSlug: env.CRASHPAD_GITHUB_APP_SLUG } : {}),
    dataFile: env.CRASHPAD_SERVICE_DATA ?? `${env.HOME}/.crashpad/service/state.json`,
    log,
  });
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
export function appManifest(publicUrl: string): object {
  const base = publicUrl.replace(/\/$/, "");
  return {
    name: "Crashpad",
    url: base,
    hook_attributes: { url: `${base}/github/webhook`, active: true },
    public: false,
    request_oauth_on_install: false,
    default_permissions: { checks: "write", contents: "write", pull_requests: "write", metadata: "read" },
    default_events: ["pull_request", "check_run"],
  };
}
