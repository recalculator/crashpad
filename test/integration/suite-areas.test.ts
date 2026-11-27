import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveContext, suiteInputFrom } from "../../src/context.ts";
import { discoverer } from "../../src/discovery/index.ts";
import { runSuite } from "../../src/suite/runner.ts";
import { renderSuiteMarkdown } from "../../src/suite/markdown.ts";
import { DB_URL, tempDir } from "../helpers/project.ts";
import { buildScenarioRepo, loadScenarios, NOTES_API, NOTES_SCENARIOS, OPTIONAL_ENV_APP, type Scenario } from "../helpers/scenario.ts";

/**
 * All five check areas against a real application: the notes-api fixture runs as
 * a real Node.js process on a real PostgreSQL server, its baseline and candidate
 * are real Git commits, and its configuration is DISCOVERED (the fixture has no
 * crashpad.config.json). Every expected failure is produced by actually running it.
 */

beforeAll(() => {
  process.env.CRASHPAD_HOME = tempDir("crashpad-home-");
});

async function check(repo: string) {
  const ctx = await resolveContext({ cwd: repo, base: "main", head: "change", databaseUrl: DB_URL });
  return runSuite({ ...suiteInputFrom(ctx, DB_URL), discover: discoverer() });
}

describe("notes-api fixture (discovered configuration, real app processes)", () => {
  it("has no repository-specific Crashpad config file", () => {
    expect(fs.existsSync(path.join(NOTES_API, "crashpad.config.json"))).toBe(false);
  });

  for (const s of loadScenarios(NOTES_SCENARIOS)) {
    it(`${s.name}: ${s.title}`, async () => {
      const repo = buildScenarioRepo(s, tempDir(), NOTES_API);
      const { report } = await check(repo);
      const byId = new Map(report.findings.map((f) => [f.id, f]));
      const md = renderSuiteMarkdown(report);
      for (const [id, cls] of Object.entries(s.expect ?? {})) expect(byId.get(id)?.classification, `${id}\n${md}`).toBe(cls);
      for (const [id, code] of Object.entries(s.expectErrorCode ?? {})) expect(report.database?.checks.find((c) => c.id === id)?.candidate.error?.code, id).toBe(code);
      expect(report.exitCode, md).toBe(s.expectedExit);
      expect(report.configSources).toEqual(["discovered"]);
      for (const c of report.coverage) expect(c.status, `${c.area}\n${md}`).toBe(s.expectCoverage?.[c.area] ?? "complete");
      for (const [area, text] of Object.entries(s.expectMissing ?? {})) expect(report.coverage.find((c) => c.area === area)!.missing.join("\n")).toContain(text);
      // Every finding that is not a pass carries concrete evidence or a precise message.
      for (const f of report.findings.filter((x) => x.classification === "regression")) expect(f.message.length).toBeGreaterThan(10);
    });
  }
});

describe("applicability", () => {
  function repoWith(files: Record<string, string>, change: Record<string, string> = {}): string {
    const dir = tempDir();
    const write = (fs_: Record<string, string>) => {
      for (const [p, c] of Object.entries(fs_)) {
        fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
        fs.writeFileSync(path.join(dir, p), c);
      }
    };
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
    write(files);
    g("init", "-q", "-b", "main");
    g("add", "-A");
    g("commit", "-q", "-m", "base");
    g("switch", "-q", "-c", "change");
    write(change);
    g("add", "-A");
    g("commit", "-q", "--allow-empty", "-m", "change");
    return dir;
  }

  it("runs an app without a database without needing PostgreSQL at all", async () => {
    const server = `import http from "node:http";\nhttp.createServer((q, s) => { s.writeHead(200, {"content-type": "application/json"}); s.end(JSON.stringify(q.url === "/health" ? {ok: true} : {items: []})); }).listen(Number(process.env.PORT), "127.0.0.1");\n`;
    const repo = repoWith({
      "package.json": JSON.stringify({ type: "module", scripts: { start: "node server.js" } }),
      "server.js": server,
      ".env.example": "PORT=3000\n",
      "openapi.json": JSON.stringify({ openapi: "3.0.3", info: { title: "t", version: "1" }, paths: { "/health": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } } } } } } }, "/items": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["items"], properties: { items: { type: "array" } } } } } } } } } } }),
    });
    const ctx = await resolveContext({ cwd: repo, base: "main", head: "change" });
    // An unreachable PostgreSQL URL: it must never be contacted.
    const { report } = await runSuite({ ...suiteInputFrom(ctx, "postgres://127.0.0.1:1/none"), discover: discoverer() });
    expect(report.exitCode, renderSuiteMarkdown(report)).toBe(0);
    expect(report.coverage.find((c) => c.area === "database")?.status).toBe("not-applicable");
    expect(report.findings.find((f) => f.id === "api:smoke:GET /items")?.classification).toBe("pass");
    expect(report.findings.find((f) => f.id === "config:startup")?.classification).toBe("pass");
    expect(report.coverage.find((c) => c.area === "permissions")?.status).toBe("not-configured");
    expect(report.complete).toBe(false);
  });

  it("reports an unsupported project precisely and never as passing", async () => {
    const repo = repoWith({ "README.md": "# docs only\n", "main.go": "package main\n" }, { "README.md": "# changed\n" });
    const ctx = await resolveContext({ cwd: repo, base: "main", head: "change" });
    const { report } = await runSuite({ ...suiteInputFrom(ctx, DB_URL), discover: discoverer() });
    const md = renderSuiteMarkdown(report);
    expect(report.exitCode).toBe(2);
    expect(report.headline).toBe("Nothing was verified: no applicable checks ran");
    expect(report.findings).toEqual([]);
    expect(md).toContain("no package.json: only Node.js projects are supported");
    expect(md).toContain("no OpenAPI document found");
  });
});

describe("onboarding defects found in the real-project trial (regression coverage)", () => {
  // Shaped like the trial project: blank optional keys in .env.example and a port read from
  // APP_PORT (declared only as a commented default). Before the fix, Crashpad reported the
  // blank keys as missing required variables and could not start the app on its port.
  const scenario = (over: Partial<Scenario>): Scenario => ({ name: "optional-env", dir: OPTIONAL_ENV_APP, title: "", description: "", mode: "check", expectedExit: 0, ...over });

  it("does not treat blank keys of a dotenv example as missing, and discovers the port variable", async () => {
    const repo = buildScenarioRepo(scenario({}), tempDir(), OPTIONAL_ENV_APP);
    const ctx = await resolveContext({ cwd: repo, base: "main", head: "change" });
    const { report, candidateConfig } = await runSuite({ ...suiteInputFrom(ctx, "postgres://127.0.0.1:1/none"), discover: discoverer() });
    const md = renderSuiteMarkdown(report);
    expect(candidateConfig?.app?.portEnv).toBe("APP_PORT");
    expect(report.findings.filter((f) => f.id.startsWith("config:env:") && f.id !== "config:env:schema"), md).toEqual([]);
    expect(report.findings.find((f) => f.id === "config:startup")?.classification, md).toBe("pass");
    expect(report.exitCode, md).toBe(0);
    expect(md).toContain("1 variable(s), 0 with a test value");
  });

  it("catches a startup regression from an incomplete rename", async () => {
    const repo = buildScenarioRepo(scenario({ replace: [{ file: "lib.js", find: "export function greet(", with: "export function sayHello(" }] }), tempDir(), OPTIONAL_ENV_APP);
    const ctx = await resolveContext({ cwd: repo, base: "main", head: "change" });
    const { report } = await runSuite({ ...suiteInputFrom(ctx, "postgres://127.0.0.1:1/none"), discover: discoverer() });
    const f = report.findings.find((x) => x.id === "config:startup")!;
    expect(f.classification).toBe("regression");
    expect(f.evidence.map((e) => e.detail).join("\n")).toContain("does not provide an export named 'greet'");
    expect(report.exitCode).toBe(1);
  });
});
