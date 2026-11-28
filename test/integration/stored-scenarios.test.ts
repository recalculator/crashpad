import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli.ts";
import { resolveContext, suiteInputFrom } from "../../src/context.ts";
import { discoverer, repoInputsFor } from "../../src/discovery/index.ts";
import { runSuite } from "../../src/suite/runner.ts";
import { renderSuiteMarkdown } from "../../src/suite/markdown.ts";
import { DB_URL, tempDir } from "../helpers/project.ts";
import { buildScenarioRepo, loadScenarios, NOTES_API, NOTES_SCENARIOS } from "../helpers/scenario.ts";

/**
 * Runtime scenarios kept in Crashpad's per-repository storage, for projects whose owners
 * do not want a Crashpad file in the repository. The notes-api app runs for real; the
 * repository under test has NO crashpad.http.json on either version.
 */

let out = "";
beforeEach(() => {
  process.env.CRASHPAD_HOME = tempDir("crashpad-home-");
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
});
afterEach(() => vi.restoreAllMocks());

/** notes-api without its scenario file, so the repository carries no runtime expectations. */
function fixtureWithoutScenarios(): string {
  const dir = path.join(tempDir(), "notes-api");
  fs.cpSync(NOTES_API, dir, { recursive: true, filter: (p) => path.basename(p) !== "crashpad.http.json" && !p.includes("node_modules") });
  return dir;
}

const n05 = loadScenarios(NOTES_SCENARIOS).find((s) => s.name.startsWith("n05"))!;

async function check(repo: string) {
  const ctx = await resolveContext({ cwd: repo, base: "main", head: "change", databaseUrl: DB_URL });
  const inputs = await repoInputsFor(repo);
  const { report } = await runSuite({ ...suiteInputFrom(ctx, DB_URL), discover: discoverer(), ...inputs });
  return { report, md: renderSuiteMarkdown(report), byId: new Map(report.findings.map((f) => [f.id, f])) };
}

describe("scenarios stored in Crashpad's storage", () => {
  it("without stored scenarios, permissions and workflows are not configured", async () => {
    const repo = buildScenarioRepo(n05, tempDir(), fixtureWithoutScenarios());
    const { report } = await check(repo);
    expect(report.coverage.find((c) => c.area === "permissions")!.status).toBe("not-configured");
  });

  it("imported scenarios catch a permission regression with nothing added to the repository", async () => {
    const repo = buildScenarioRepo(n05, tempDir(), fixtureWithoutScenarios());
    expect(await main(["scenarios", "--import", path.join(NOTES_API, "crashpad.http.json")], repo)).toBe(0);
    expect(out).toMatch(/scenario\(s\) stored in .*crashpad\.http\.json[\s\S]*permissions \d+, workflows \d+[\s\S]*same expectations apply to the baseline and the candidate/);
    const stored = fs.readdirSync(path.join(process.env.CRASHPAD_HOME!, "repos")).map((d) => path.join(process.env.CRASHPAD_HOME!, "repos", d, "crashpad.http.json")).find((f) => fs.existsSync(f))!;
    expect(fs.statSync(stored).mode & 0o777).toBe(0o600);
    const { report, md, byId } = await check(repo);
    expect(byId.get("permissions:note-visible-to-owner-and-admin")?.classification, md).toBe("regression");
    expect(byId.get("workflows:signup-login-create-update")?.classification, md).toBe("pass");
    expect(report.exitCode).toBe(1);
    expect(report.coverage.find((c) => c.area === "permissions")!.ran.join("\n")).toMatch(/scenarios from Crashpad's storage .* not from the repository: the same expectations are applied to both versions/);
    // Discovery's "no scenarios" gap is gone, and the repository still has no Crashpad files.
    expect(report.coverage.find((c) => c.area === "permissions")!.missing.join("\n")).not.toMatch(/no permission scenarios/);
    expect(execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" })).not.toMatch(/crashpad\.http\.json/);
    // Setup reports them as found.
    out = "";
    expect(await main(["discover"], repo)).toBe(0);
    expect(out).toMatch(/Permissions\s+\S+[\s\S]*found: \d+ runtime scenario\(s\) stored in Crashpad's storage/);
  });

  it("a repository's own crashpad.http.json takes precedence, and the report says so", async () => {
    const repo = buildScenarioRepo(n05, tempDir(), NOTES_API);
    const other = path.join(tempDir(), "s.json");
    fs.writeFileSync(other, JSON.stringify({ version: 1, identities: {}, checks: [] }));
    expect(await main(["scenarios", "--import", other], repo)).toBe(0);
    const { report } = await check(repo);
    expect(report.coverage.find((c) => c.area === "permissions")!.ran.join("\n")).toContain("scenarios stored in Crashpad's storage are ignored");
    expect(report.findings.find((f) => f.id === "permissions:note-visible-to-owner-and-admin")?.classification).toBe("regression");
  });

  it("rejects invalid scenario files on import and can remove stored ones", async () => {
    const repo = buildScenarioRepo(n05, tempDir(), fixtureWithoutScenarios());
    const bad = path.join(tempDir(), "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ version: 1, checks: [{ id: "x" }] }));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["scenarios", "--import", bad], repo)).toBe(2);
    expect(await main(["scenarios", "--import", path.join(NOTES_API, "crashpad.http.json")], repo)).toBe(0);
    expect(await main(["scenarios", "--remove"], repo)).toBe(0);
    expect((await repoInputsFor(repo)).storedHttp).toBeUndefined();
  });
});

describe("repair with stored scenarios", () => {
  it("verifies against the scenarios loaded at the start, even if the stored file is edited during the repair", async () => {
    const { repair } = await import("../../src/repair/loop.ts");
    const { ClaudeCodeAgent } = await import("../../src/repair/claude.ts");
    const { gitOut } = await import("../../src/git.ts");
    const repo = buildScenarioRepo(n05, tempDir(), fixtureWithoutScenarios());
    expect(await main(["scenarios", "--import", path.join(NOTES_API, "crashpad.http.json")], repo)).toBe(0);
    const inputs = await repoInputsFor(repo);
    const before = fs.readFileSync(inputs.storedHttp!.path, "utf8");
    const agent = new ClaudeCodeAgent({ bin: path.resolve(import.meta.dirname, "../fixtures/fake-claude/claude"), env: { FAKE_CLAUDE_MODE: "cheat-stored", FAKE_CLAUDE_STORED: inputs.storedHttp!.path, FAKE_CLAUDE_LOG: path.join(tempDir(), "log.jsonl") } });
    const r = await repair({
      repoRoot: repo,
      projectDir: ".",
      base: { ref: "main", commit: await gitOut(repo, ["rev-parse", "main"]) },
      candidate: { label: "change", commit: await gitOut(repo, ["rev-parse", "change"]) },
      databaseUrl: DB_URL,
      discover: discoverer(),
      ...inputs,
      agent,
      maxAttempts: 1,
      deadlineMs: 10 * 60_000,
      attemptTimeoutMs: 60_000,
      maxTurns: 5,
    });
    // The mock edited the stored file; verification used the copy loaded before the repair,
    // the edit is recorded as a violation, and the file is restored for later runs.
    expect(r.outcome).toBe("unresolved");
    expect(r.attempts[0]!.violations.map((v) => v.path)).toEqual([inputs.storedHttp!.path]);
    expect(fs.readFileSync(inputs.storedHttp!.path, "utf8")).toBe(before);
  });
});
