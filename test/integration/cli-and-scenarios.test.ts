import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli.ts";
import { buildScenarioRepo, loadScenarios } from "../helpers/scenario.ts";
import { DB_URL, projectFiles, tempDir, TestRepo, check, fix } from "../helpers/project.ts";

let out = "";
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((out += String(s)), true));
});
afterEach(() => vi.restoreAllMocks());

describe("CLI exit semantics", () => {
  const SCHEMA = "CREATE TABLE t (id int PRIMARY KEY, name text);";
  const mk = () => TestRepo.create(projectFiles({ schema: SCHEMA, seed: "INSERT INTO t VALUES (1, 'a');", checks: [{ id: "q", category: "read", source: "sql/q.sql" }], sql: { "q.sql": "SELECT id, name FROM t" } }));

  it("exits 0 when all checks pass and writes Markdown + JSON reports", async () => {
    const r = mk();
    const dir = tempDir();
    expect(await main(["check", "--base", "main", "--report-dir", dir, "--database-url", DB_URL], r.dir)).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(dir, "crashpad-report.json"), "utf8"));
    expect(report.schemaVersion).toBe("crashpad.suite/v1");
    expect(report.database.schemaVersion).toBe("crashpad.report/v1");
    expect(report.findings.find((f: { id: string }) => f.id === "database:q").classification).toBe("pass");
    expect(fs.readFileSync(path.join(dir, "crashpad-report.md"), "utf8")).toContain("All 1 check(s) passed");
  });

  it("exits 1 on a regression", async () => {
    const r = mk();
    r.write({ "db/migrations/001.sql": "ALTER TABLE t DROP COLUMN name;" });
    expect(await main(["check", "--base", "main", "--database-url", DB_URL], r.dir)).toBe(1);
    expect(out).toContain("42703");
  });

  it("exits 2 on usage errors, bad refs, and invalid configuration", async () => {
    const r = mk();
    expect(await main(["check"], r.dir)).toBe(2);
    expect(await main(["check", "--base", "main", "--bogus"], r.dir)).toBe(2);
    expect(await main(["check", "--base", "no-such-ref", "--database-url", DB_URL], r.dir)).toBe(2);
    r.write({ "checks.json": "{ not json" });
    expect(await main(["check", "--base", "main", "--database-url", DB_URL], r.dir)).toBe(2);
    expect(await main(["validate"], r.dir)).toBe(2);
  });

  it("exits 2 when PostgreSQL is unreachable (never green)", async () => {
    const r = mk();
    expect(await main(["check", "--base", "main", "--database-url", "postgres://localhost:1/postgres"], r.dir)).toBe(2);
    expect(out).toContain("infrastructure");
  });

  it("fix --apply writes only a verified patch to the working tree", async () => {
    const r = mk();
    r.write({ "db/migrations/001.sql": "ALTER TABLE t RENAME COLUMN name TO label;" });
    expect(await main(["fix", "--base", "main", "--out", tempDir(), "--apply", "--database-url", DB_URL], r.dir)).toBe(0);
    expect(r.read("sql/q.sql")).toBe("SELECT id, label AS name FROM t");
  });
});

describe("scenario fixtures (test/fixtures/scenarios)", () => {
  for (const s of loadScenarios()) {
    it(`${s.name}: ${s.title}`, async () => {
      const repoDir = buildScenarioRepo(s, tempDir());
      const repo = new TestRepo(repoDir);
      if (s.mode === "check") {
        const res = await check(repo, "main");
        expect(res.report.exitCode).toBe(s.expectedExit);
        for (const [id, cls] of Object.entries(s.expect ?? {})) expect(res.report.checks.find((c) => c.id === id)?.classification, id).toBe(cls);
        for (const [id, code] of Object.entries(s.expectErrorCode ?? {})) expect(res.report.checks.find((c) => c.id === id)?.candidate.error?.code, id).toBe(code);
      } else {
        const res = await fix(repo, "main");
        expect(res.outcome).toBe(s.expectOutcome);
        expect(res.plan.edits.map((e) => e.path).sort()).toEqual([...(s.expectEdited ?? [])].sort());
      }
    });
  }
});
