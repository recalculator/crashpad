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
    expect(files.some((f) => f.startsWith("src/") || f.startsWith("test/") || f.includes(".env"))).toBe(false);

    const app = tempDir("crashpad-install-");
    expect(path.relative(ROOT, app).startsWith("..")).toBe(true);
    execFileSync("npm", ["init", "-y"], { cwd: app, stdio: "ignore" });
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", path.join(out, packed.filename)], { cwd: app, stdio: "ignore" });
    const bin = path.join(app, "node_modules", ".bin", "crashpad");
    expect(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()).toBe(VERSION);

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
  });
});
