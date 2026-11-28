import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli.ts";
import { appManifest } from "../../src/commands/companion.ts";
import { checkServiceConfig, convertManifestCode, REQUIRED_EVENTS, REQUIRED_PERMISSIONS } from "../../src/service/config.ts";
import { CrashpadService } from "../../src/service/server.ts";
import { VERSION } from "../../src/version.ts";
import { tempDir } from "../helpers/project.ts";
import { FakeGitHubServer } from "../helpers/fake-github-server.ts";

/**
 * Deployment preparation for the GitHub App service: configuration validation, the
 * manifest, local registration (manifest code exchange), and the health check.
 * GitHub is FAKED here (test/helpers/fake-github-server.ts); none of this has run
 * against github.com.
 */

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
let gh: FakeGitHubServer;

beforeAll(async () => {
  gh = new FakeGitHubServer(publicKey);
  gh.manifestPem = privateKey;
  await gh.start();
});
afterAll(async () => gh.stop?.());
afterEach(() => vi.restoreAllMocks());

function validEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const dir = tempDir();
  const key = path.join(dir, "app.private-key.pem");
  fs.writeFileSync(key, privateKey, { mode: 0o600 });
  return {
    CRASHPAD_GITHUB_APP_ID: gh.appId,
    CRASHPAD_GITHUB_CLIENT_ID: gh.clientId,
    CRASHPAD_GITHUB_APP_SLUG: gh.slug,
    CRASHPAD_GITHUB_PRIVATE_KEY_FILE: key,
    CRASHPAD_GITHUB_WEBHOOK_SECRET: "a".repeat(64),
    CRASHPAD_SERVICE_DATA: path.join(dir, "data", "state.json"),
    ...over,
  };
}

const errors = (r: Awaited<ReturnType<typeof checkServiceConfig>>) => r.items.filter((i) => i.level === "error").map((i) => i.message).join("\n");
const warnings = (r: Awaited<ReturnType<typeof checkServiceConfig>>) => r.items.filter((i) => i.level === "warn").map((i) => i.message).join("\n");

describe("service configuration validation", () => {
  it("names every missing setting", async () => {
    const r = await checkServiceConfig({});
    expect(r.ok).toBe(false);
    for (const k of ["APP_ID", "CLIENT_ID", "APP_SLUG", "WEBHOOK_SECRET", "PRIVATE_KEY_FILE", "SERVICE_DATA"]) expect(errors(r)).toContain(`CRASHPAD_${k.startsWith("SERVICE") ? k : `GITHUB_${k}`}`);
  });

  it("accepts a complete configuration and creates the state directory", async () => {
    const env = validEnv();
    const r = await checkServiceConfig(env);
    expect(errors(r)).toBe("");
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.dirname(env.CRASHPAD_SERVICE_DATA!))).toBe(true);
    expect(r.config).toMatchObject({ appId: gh.appId, clientId: gh.clientId, appSlug: gh.slug, apiUrl: "https://api.github.com" });
  });

  it("rejects bad values and warns about weak ones", async () => {
    const ec = path.join(tempDir(), "ec.pem");
    fs.writeFileSync(ec, generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey, { mode: 0o600 });
    const r = await checkServiceConfig(validEnv({ CRASHPAD_GITHUB_APP_ID: "crashpad", CRASHPAD_GITHUB_APP_SLUG: "Crashpad App", CRASHPAD_GITHUB_PRIVATE_KEY_FILE: ec, CRASHPAD_SERVICE_DATA: "state.json" }));
    expect(errors(r)).toMatch(/numeric App ID[\s\S]*not an App slug[\s\S]*ec key; GitHub App keys are RSA[\s\S]*must be an absolute path/);
    const env = validEnv({ CRASHPAD_GITHUB_WEBHOOK_SECRET: "short", CRASHPAD_SERVICE_DATA: "/tmp/crashpad-test-state/state.json" });
    fs.chmodSync(env.CRASHPAD_GITHUB_PRIVATE_KEY_FILE!, 0o644);
    const w = await checkServiceConfig(env);
    expect(w.ok).toBe(true);
    expect(warnings(w)).toMatch(/at least 32[\s\S]*readable by other users[\s\S]*cleared on reboot/);
    fs.rmSync("/tmp/crashpad-test-state", { recursive: true, force: true });
  });

  it("--online: GitHub (faked) confirms the App ID, key, slug, and client ID belong together", async () => {
    expect(errors(await checkServiceConfig(validEnv({ CRASHPAD_GITHUB_API_URL: gh.url }), { online: true }))).toBe("");
    expect(errors(await checkServiceConfig(validEnv({ CRASHPAD_GITHUB_API_URL: gh.url, CRASHPAD_GITHUB_APP_SLUG: "someone-else" }), { online: true }))).toMatch(/slug is crashpad-test/);
    expect(errors(await checkServiceConfig(validEnv({ CRASHPAD_GITHUB_API_URL: gh.url, CRASHPAD_GITHUB_APP_ID: "1" }), { online: true }))).toMatch(/do not belong together/);
  });

  it("the service refuses to start with an invalid configuration", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith("CRASHPAD_GITHUB_") || k === "CRASHPAD_SERVICE_DATA") delete process.env[k];
    try {
      expect(await main(["service"])).toBe(2);
    } finally {
      process.env = saved;
    }
  });
});

describe("App manifest and registration", () => {
  it("requests exactly the permissions and events the service uses, and requires HTTPS", () => {
    const m = appManifest("https://crashpad.example.com/", { redirectUrl: "http://localhost:3999/callback" });
    expect(m).toMatchObject({
      url: "https://crashpad.example.com",
      hook_attributes: { url: "https://crashpad.example.com/github/webhook", active: true },
      redirect_url: "http://localhost:3999/callback",
      public: false,
      default_permissions: { checks: "write", contents: "write", pull_requests: "write", metadata: "read" },
      default_events: ["pull_request", "check_run"],
    });
    expect(m.default_permissions).toEqual(REQUIRED_PERMISSIONS);
    expect(m.default_events).toEqual(REQUIRED_EVENTS);
    expect(() => appManifest("http://crashpad.example.com")).toThrow(/https/);
  });

  it("exchanges a manifest code for credentials written with mode 600, and never overwrites them", async () => {
    gh.manifestCodes.add("code1");
    const out = tempDir();
    const r = await convertManifestCode({ code: "code1", outDir: out, apiUrl: gh.url });
    expect(r).toMatchObject({ slug: gh.slug, appId: gh.appId });
    expect(fs.statSync(r.keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(r.envFile).mode & 0o777).toBe(0o600);
    const env = fs.readFileSync(r.envFile, "utf8");
    expect(env).toContain(`CRASHPAD_GITHUB_APP_ID=${gh.appId}`);
    expect(env).toContain(`CRASHPAD_GITHUB_CLIENT_ID=${gh.clientId}`);
    expect(env).toContain("CRASHPAD_GITHUB_PRIVATE_KEY_FILE=/etc/crashpad/app.private-key.pem");
    expect(env).toContain("CRASHPAD_SERVICE_DATA=/var/lib/crashpad/state.json");
    gh.manifestCodes.add("code2");
    await expect(convertManifestCode({ code: "code2", outDir: out, apiUrl: gh.url })).rejects.toThrow(/refusing to overwrite/);
    await expect(convertManifestCode({ code: "used-or-expired", outDir: tempDir(), apiUrl: gh.url })).rejects.toThrow(/did not convert the code/);
  });

  it("`crashpad service register`: local page → GitHub (faked) → localhost callback → credentials", async () => {
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = path.join(tempDir(), "creds");
    const port = 39000 + Math.floor(Math.random() * 900);
    process.env.CRASHPAD_GITHUB_API_URL = gh.url;
    try {
      const done = main(["service", "register", "--url", "https://crashpad.example.com", "--port", String(port), "--out", dir]);
      await new Promise((r) => setTimeout(r, 200));
      const page = await (await fetch(`http://localhost:${port}/`)).text();
      expect(page).toContain('action="https://github.com/settings/apps/new?state=');
      const state = page.match(/state=([0-9a-f]+)/)![1]!;
      const manifest = JSON.parse(page.match(/name="manifest" value="([^"]+)"/)![1]!.replace(/&#34;/g, '"').replace(/&#38;/g, "&"));
      expect(manifest.redirect_url).toBe(`http://localhost:${port}/callback`);
      expect((await fetch(`http://localhost:${port}/callback?code=x&state=wrong`)).status).toBe(400);
      gh.manifestCodes.add("goodcode");
      expect((await fetch(`http://localhost:${port}/callback?code=goodcode&state=${state}`)).status).toBe(200);
      expect(await done).toBe(0);
      expect(fs.existsSync(path.join(dir, "app.private-key.pem"))).toBe(true);
      expect(out).toMatch(/Enable Device Flow/);
    } finally {
      delete process.env.CRASHPAD_GITHUB_API_URL;
    }
  });
});

describe("health check and persistence", () => {
  it("/healthz reports version and storage; state survives a restart", async () => {
    const dataFile = path.join(tempDir(), "state.json");
    const cfg = { appId: gh.appId, privateKeyPem: privateKey, webhookSecret: "s".repeat(40), apiUrl: gh.url, webUrl: "https://github.com", clientId: gh.clientId, appSlug: gh.slug, dataFile };
    const svc = new CrashpadService(cfg);
    const port = await svc.listen(0, "127.0.0.1");
    const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    expect(h).toEqual({ ok: true, version: VERSION, storage: "ok", companionsOnline: 0 });
    // A signed installation webhook is persisted.
    const body = JSON.stringify({ action: "created", installation: { id: 77, account: { login: "acme" }, repository_selection: "selected" }, repositories: [{ full_name: "acme/app" }] });
    const sig = `sha256=${createHmac("sha256", cfg.webhookSecret).update(body).digest("hex")}`;
    const r = await fetch(`http://127.0.0.1:${port}/github/webhook`, { method: "POST", body, headers: { "content-type": "application/json", "x-github-event": "installation", "x-github-delivery": "d1", "x-hub-signature-256": sig } });
    expect(r.status).toBe(200);
    await svc.close();
    const again = new CrashpadService(cfg);
    expect(again.store.installation(77)).toBeTruthy();
    expect(fs.statSync(dataFile).mode & 0o777).toBe(0o600);
  });
});

describe("deployment package scripts (deploy/)", () => {
  const DEPLOY = path.resolve(import.meta.dirname, "../../deploy");


  it("backup.sh keeps dated, valid copies, prunes old ones, and refuses corrupt state", () => {
    const dir = tempDir();
    const data = path.join(dir, "state.json");
    const backups = path.join(dir, "backups");
    const env = { ...process.env, CRASHPAD_SERVICE_DATA: data, CRASHPAD_BACKUP_DIR: backups, CRASHPAD_BACKUP_KEEP: "2" };
    expect(execFileSync("sh", [path.join(DEPLOY, "backup.sh")], { env, encoding: "utf8" })).toMatch(/does not exist yet/);
    fs.writeFileSync(data, JSON.stringify({ installations: {} }));
    for (let i = 0; i < 3; i++) {
      // Older backups already present.
      fs.mkdirSync(backups, { recursive: true });
      fs.writeFileSync(path.join(backups, `state-2026010${i}T000000Z.json`), "{}");
    }
    const outp = execFileSync("sh", [path.join(DEPLOY, "backup.sh")], { env, encoding: "utf8" });
    expect(outp).toMatch(/\(2 kept\)/);
    const kept = fs.readdirSync(backups).filter((f) => f.startsWith("state-")).sort();
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe("state-20260102T000000Z.json");
    expect(JSON.parse(fs.readFileSync(path.join(backups, kept[1]!), "utf8"))).toEqual({ installations: {} });
    expect(fs.statSync(path.join(backups, kept[1]!)).mode & 0o077).toBe(0);
    fs.writeFileSync(data, "{ truncated");
    const bad = spawnSync("sh", [path.join(DEPLOY, "backup.sh")], { env, encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/not valid JSON; nothing was kept/);
    expect(fs.readdirSync(backups).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("healthcheck.sh passes against a running service", async () => {
    const svc = new CrashpadService({ appId: gh.appId, privateKeyPem: privateKey, webhookSecret: "s".repeat(40), apiUrl: gh.url, webUrl: "https://github.com", clientId: gh.clientId, appSlug: gh.slug, dataFile: path.join(tempDir(), "state.json") });
    const port = await svc.listen(0, "127.0.0.1");
    try {
      const r = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const p = spawn("sh", [path.join(DEPLOY, "healthcheck.sh"), `http://127.0.0.1:${port}/`]);
        let stdout = "";
        p.stdout.on("data", (d) => (stdout += d));
        p.on("close", (status) => resolve({ status, stdout }));
      });
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toMatch(/✓ GET \/healthz[\s\S]*✓ unsigned webhook rejected \(401\)[\s\S]*✓ companion API requires a companion token \(401\)[\s\S]*✓ other paths are not served \(404\)/);
    } finally {
      await svc.close();
    }
  });

  it("the systemd unit validates the configuration before starting and keeps state in /var/lib/crashpad", () => {
    const unit = fs.readFileSync(path.join(DEPLOY, "crashpad.service"), "utf8");
    expect(unit).toMatch(/ExecStartPre=.*crashpad service check/);
    expect(unit).toMatch(/ExecStart=.*crashpad service --host 127\.0\.0\.1 --port 8787/);
    expect(unit).toMatch(/StateDirectory=crashpad/);
    expect(fs.readFileSync(path.join(DEPLOY, "service.env.example"), "utf8")).toContain("CRASHPAD_SERVICE_DATA=/var/lib/crashpad/state.json");
    expect(fs.readFileSync(path.join(DEPLOY, "Caddyfile"), "utf8")).toMatch(/path \/github\/webhook \/api\/\* \/healthz[\s\S]*max_size 5MB[\s\S]*respond 404/);
  });
});
