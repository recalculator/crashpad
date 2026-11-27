import { describe, expect, it } from "vitest";
import { byId, check, g, projectFiles, TestRepo, type CheckSpec } from "../helpers/project.ts";

const SCHEMA = "CREATE TABLE customers (id int PRIMARY KEY, name text NOT NULL, email text);";
const SEED = "INSERT INTO customers VALUES (1, 'Ann', 'a@example.test'), (2, 'Bob', NULL);";
const CHECKS: CheckSpec[] = [
  { id: "names", category: "read", source: "sql/names.sql" },
  { id: "count", category: "assertion", sql: "SELECT count(*) = 2 FROM customers" },
];
const base = () => TestRepo.create(projectFiles({ schema: SCHEMA, seed: SEED, checks: CHECKS, sql: { "names.sql": "SELECT id, name FROM customers" } }));
const manifest = (checks: CheckSpec[], retired: Array<{ id: string; reason: string }> = []) => JSON.stringify({ version: 1, checks, retired });

describe("comparison against a Git baseline reference", () => {
  it("reads baseline fixtures and SQL from the baseline commit, candidate from the working tree", async () => {
    const r = base();
    // A query-only change with no migration: the app starts reading a column that does not exist.
    r.write({ "sql/names.sql": "SELECT id, name, phone FROM customers" });
    const res = await check(r);
    const f = byId(res).get("names")!;
    expect(res.report.migrations.new).toEqual([]);
    expect(f).toMatchObject({ classification: "regression", fixtureChanged: true });
    expect(f.candidate.error).toMatchObject({ code: "42703", at: { path: "sql/names.sql", line: 1, column: 18 } });
    expect(f.baseline.status).toBe("ok");
  });

  it("detects a query-only change that alters the response contract", async () => {
    const r = base();
    r.write({ "sql/names.sql": "SELECT id, upper(name) AS name FROM customers" });
    expect(byId(await check(r)).get("names")!).toMatchObject({ classification: "changed-result", reason: "rows-changed" });
  });

  it("can compare two commits without touching the working tree", async () => {
    const r = base();
    r.write({ "sql/names.sql": "SELECT id, nickname FROM customers" });
    const head = r.commit("break names");
    g(r.dir, "checkout", "-q", "main~0");
    r.write({ "sql/names.sql": "SELECT id, name FROM customers -- local edit, ignored" });
    const res = await check(r, "main~1", head);
    expect(res.report.candidate.commit).toBe(head);
    expect(byId(res).get("names")!.classification).toBe("regression");
  });

  it("identifies newly added checks", async () => {
    const r = base();
    r.write({
      "checks.json": manifest([...CHECKS, { id: "emails", category: "read", sql: "SELECT email FROM customers" }, { id: "new-bad", category: "read", sql: "SELECT nope FROM customers" }]),
    });
    const res = byId(await check(r));
    expect(res.get("emails")!).toMatchObject({ isNew: true, classification: "pass", baseline: { status: "not-present" } });
    expect(res.get("new-bad")!).toMatchObject({ isNew: true, classification: "regression" });
  });

  it("flags a removed check for review instead of treating it as success", async () => {
    const r = base();
    r.write({ "checks.json": manifest([CHECKS[0]!]) });
    const res = await check(r);
    expect(byId(res).get("count")!).toMatchObject({ classification: "removed", candidate: { status: "not-present" } });
    expect(res.report.exitCode).toBe(1);
  });

  it("accepts a removal that is explicitly retired with a reason", async () => {
    const r = base();
    r.write({ "checks.json": manifest([CHECKS[0]!], [{ id: "count", reason: "customers are now soft-deleted; see soft-delete check" }]) });
    const res = await check(r);
    expect(byId(res).get("count")!.classification).toBe("retired");
    expect(res.report.exitCode).toBe(0);
  });

  it("detects new migration files relative to the baseline and leaves baseline ones alone", async () => {
    const r = TestRepo.create(projectFiles({ schema: SCHEMA, seed: SEED, checks: CHECKS, sql: { "names.sql": "SELECT id, name FROM customers" }, migrations: { "001.sql": "ALTER TABLE customers ADD COLUMN a int;" } }));
    r.write({ "db/migrations/002.sql": "ALTER TABLE customers RENAME COLUMN name TO full_name;" });
    const res = await check(r);
    expect(res.report.migrations.baseline).toEqual(["db/migrations/001.sql"]);
    expect(res.report.migrations.new.map((m) => m.file)).toEqual(["db/migrations/002.sql"]);
    expect(byId(res).get("names")!.classification).toBe("regression");
  });

  it("runs migrations that cannot use a transaction (CREATE INDEX CONCURRENTLY) and ones with their own BEGIN/COMMIT", async () => {
    const r = base();
    r.write({
      "db/migrations/001.sql": "CREATE INDEX CONCURRENTLY customers_name_idx ON customers (name);",
      "db/migrations/002.sql": "BEGIN; ALTER TABLE customers ADD COLUMN b int; COMMIT;",
    });
    const res = await check(r);
    expect(res.report.migrations.new.map((m) => m.status)).toEqual(["applied", "applied"]);
    expect(res.report.exitCode).toBe(0);
  });

  it("exits 2 when the baseline has no Crashpad configuration", async () => {
    const r = TestRepo.create({ "README.md": "nothing here" });
    r.write(projectFiles({ schema: SCHEMA, checks: [] }));
    const res = await check(r);
    expect(res.report.problems[0]!.message).toContain("baseline");
    expect(res.report.exitCode).toBe(2);
  });
});
