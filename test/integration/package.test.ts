import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/version.ts";
import { DB_URL, tempDir } from "../helpers/project.ts";
import { buildScenarioRepo, loadScenarios, NOTES_API, NOTES_SCENARIOS } from "../helpers/scenario.ts";

/**
 * Builds the npm package archive with `npm pack`, installs it into an empty
 * directory outside the source checkout, and runs the installed CLI against a
 * discovered fixture repository. Nothing is published to a registry.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");

describe("packaged CLI", () => {
  it("installs from the archive in a clean directory and runs a real check", async () => {
    const out = tempDir("crashpad-pack-");
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", out], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
    const files: string[] = packed.files.map((f: { path: string }) => f.path);
    expect(files).toContain("dist/cli.js");
    expect(files).toContain("bin/crashpad.js");
    // The deployment package ships with it.
    for (const f of ["deploy/install.sh", "deploy/crashpad.service", "deploy/crashpad-backup.timer", "deploy/backup.sh", "deploy/healthcheck.sh", "deploy/Caddyfile", "deploy/README.md"]) expect(files).toContain(f);
    expect(files.some((f) => f.startsWith("src/") || f.startsWith("test/") || /(^|\/)\.env(\.|$)/.test(f) || /\.pem$/.test(f))).toBe(false);

    const app = tempDir("crashpad-install-");
    expect(path.relative(ROOT, app).startsWith("..")).toBe(true);
    execFileSync("npm", ["init", "-y"], { cwd: app, stdio: "ignore" });
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", path.join(out, packed.filename)], { cwd: app, stdio: "ignore" });
    const bin = path.join(app, "node_modules", ".bin", "crashpad");
    expect(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()).toBe(VERSION);
    // The installed service validates its configuration and refuses to start without one.
    const svc = (() => {
      try {
        return { code: 0, out: execFileSync(bin, ["service", "check"], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: tempDir() } }) };
      } catch (err) {
        return { code: (err as { status: number }).status, out: String((err as { stdout: string }).stdout) };
      }
    })();
    expect(svc.code).toBe(2);
    expect(svc.out).toMatch(/CRASHPAD_GITHUB_APP_ID is not set[\s\S]*the service will not start/);

    const s = loadScenarios(NOTES_SCENARIOS).find((x) => x.name === "n05-permission-regression")!;
    const repo = buildScenarioRepo(s, tempDir(), NOTES_API);
    let code = 0;
    let stdout = "";
    try {
      stdout = execFileSync(bin, ["check", "--base", "main", "--head", "change", "--database-url", DB_URL], { cwd: repo, encoding: "utf8", env: { ...process.env, CRASHPAD_HOME: tempDir() } });
    } catch (err) {
      code = (err as { status: number }).status;
      stdout = String((err as { stdout: string }).stdout);
    }
    expect(code, stdout).toBe(1);
    expect(stdout).toContain("permissions:note-visible-to-owner-and-admin");
    expect(stdout).toContain("Configuration: discovered");
    expect(fs.existsSync(path.join(repo, "crashpad.config.json"))).toBe(false);

    // Onboarding with the installed CLI: discovery, then an override stored outside the repository.
    const home = tempDir();
    const run = (args: string[], cwd: string) => execFileSync(bin, args, { cwd, encoding: "utf8", env: { ...process.env, CRASHPAD_HOME: home } });
    const discovered = run(["discover"], repo);
    for (const area of ["Database compatibility", "API contracts", "Configuration and startup", "Permissions", "Application workflows"]) expect(discovered).toMatch(new RegExp(`${area}\\s+ready`));
    const partial = buildScenarioRepo({ ...s, replace: [{ file: "package.json", find: '"start": "node server.js",', with: "" }], remove: ["crashpad.http.json"] }, tempDir(), NOTES_API);
    const before = run(["discover"], partial);
    expect(before).toContain('missing: no "start" script in package.json');
    expect(before).toMatch(/Permissions\s+needs input/);
    expect(before).toContain("access expectations must be stated explicitly and are never inferred");
    run(["settings", "--set", 'app.start=["node","server.js"]'], partial);
    const after = run(["discover"], partial);
    expect(after).not.toContain('no "start" script');
    expect(after).toMatch(/Configuration and startup\s+ready/);
    expect(after).toContain("[discovered + Crashpad settings]");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: partial, encoding: "utf8" })).toBe("");
  });
});
