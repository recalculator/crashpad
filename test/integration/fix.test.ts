import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Proposer, Proposal, ProposalContext } from "../../src/fix/proposer.ts";
import { fix, projectFiles, tempDir, TestRepo, type CheckSpec } from "../helpers/project.ts";

const SCHEMA = `
CREATE TABLE customers (id int PRIMARY KEY, email text NOT NULL, name text NOT NULL);
CREATE TABLE orders (id int PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id), total numeric(10,2) NOT NULL);
`;
const SEED = "INSERT INTO customers VALUES (1, 'a@example.test', 'Ann'), (2, 'b@example.test', 'Bob'); INSERT INTO orders VALUES (1, 1, 9.99);";
const SQL = {
  "profile.sql": "-- name shown on the profile page\nSELECT c.id, c.name, count(o.id) AS orders\nFROM customers c LEFT JOIN orders o ON o.customer_id = c.id\nWHERE c.id = $1\nGROUP BY c.id, c.name\n",
  "signup.sql": "INSERT INTO customers (id, email, name) VALUES ($1, $2, $3) RETURNING id, name\n",
  "search.sql": "SELECT id FROM customers WHERE name ILIKE $1 || '%' ORDER BY id\n",
};
const CHECKS: CheckSpec[] = [
  { id: "profile", category: "read", source: "sql/profile.sql", params: [1] },
  { id: "signup", category: "write", source: "sql/signup.sql", params: [10, "n@example.test", "Nia"], expectRows: 1 },
  { id: "search", category: "read", source: "sql/search.sql", params: ["A"], ordered: true },
  { id: "count", category: "assertion", sql: "SELECT count(*) = 2 FROM customers" },
];
const RENAME = { "db/migrations/001_rename.sql": "ALTER TABLE customers RENAME COLUMN name TO full_name;" };
const repo = (checks = CHECKS, sql: Record<string, string> = SQL) => TestRepo.create(projectFiles({ schema: SCHEMA, seed: SEED, checks, sql }));

/** A proposer that returns whatever edits it is given; used to test guardrails and verification. */
class FakeProposer implements Proposer {
  readonly name = "fake";
  readonly kind = "model" as const;
  private make: (ctx: ProposalContext) => Proposal["edits"];
  constructor(make: (ctx: ProposalContext) => Proposal["edits"]) {
    this.make = make;
  }
  async propose(ctx: ProposalContext): Promise<Proposal> {
    return { proposer: this.name, kind: this.kind, edits: this.make(ctx), refusals: [], facts: {} };
  }
}

describe("rename fix generation and verification", () => {
  it("rewrites the real SQL source files and verifies them against the original baseline", async () => {
    const r = repo();
    r.write(RENAME);
    const res = await fix(r);
    expect(res.outcome).toBe("verified");
    expect(res.exitCode).toBe(0);
    expect(res.original.exitCode).toBe(1);
    expect(res.verification!.exitCode).toBe(0);
    expect(res.plan.publishable).toBe(true);
    expect(res.plan.edits.map((e) => e.path)).toEqual(["sql/profile.sql", "sql/search.sql", "sql/signup.sql"]);
    const profile = res.proposal!.edits.find((e) => e.path === "sql/profile.sql")!.after;
    expect(profile).toBe("-- name shown on the profile page\nSELECT c.id, c.full_name AS name, count(o.id) AS orders\nFROM customers c LEFT JOIN orders o ON o.customer_id = c.id\nWHERE c.id = $1\nGROUP BY c.id, c.full_name\n");
    expect(res.proposal!.edits.find((e) => e.path === "sql/signup.sql")!.after).toBe(
      "INSERT INTO customers (id, email, full_name) VALUES ($1, $2, $3) RETURNING id, full_name AS name\n",
    );
    // The working tree is not modified by `fix`.
    expect(r.read("sql/profile.sql")).toBe(SQL["profile.sql"]);
    // The verification baseline is the original baseline commit and original queries.
    expect(res.verification!.base).toEqual(res.original.base);
    expect(res.verification!.candidate.label).toContain("proposed patch");
  });

  it("emits a git-applicable unified patch, a machine-readable plan, and a PR description", async () => {
    const r = repo();
    r.write(RENAME);
    const res = await fix(r);
    const patchFile = path.join(tempDir(), "fix.patch");
    fs.writeFileSync(patchFile, res.patch);
    execFileSync("git", ["apply", "--check", patchFile], { cwd: r.dir });
    expect(res.plan).toMatchObject({ schemaVersion: "crashpad.fixplan/v1", outcome: "verified", proposer: { name: "rename-fixer", kind: "deterministic" } });
    expect(res.plan.renames).toEqual([{ schema: "public", table: "customers", from: "name", to: "full_name", migration: "db/migrations/001_rename.sql" }]);
    expect(res.plan.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(res.prBody).toContain("No AI model was involved");
    expect(res.prBody).toContain("original");
    expect(res.prTitle).toBe("Crashpad: update SQL for renamed column customers.name → full_name");
  });

  it("rejects a 'fix' that changes the response, because verification compares to the ORIGINAL baseline output", async () => {
    // This proposal makes the query run, but drops the `name` response field. If
    // verification ran the patched query on both sides it would wrongly pass.
    const r = repo();
    r.write(RENAME);
    const res = await fix(r, "main", undefined, {
      proposer: new FakeProposer((ctx) => {
        const f = ctx.candidateFixtures.get("profile")!;
        return [{ path: "sql/profile.sql", before: f.sql, after: f.sql.replaceAll("c.name", "c.full_name"), changes: [], checkIds: ["profile"] }];
      }),
    });
    expect(res.outcome).toBe("partial");
    expect(res.plan.publishable).toBe(false);
    const profile = res.verification!.checks.find((c) => c.id === "profile")!;
    expect(profile).toMatchObject({ classification: "changed-result", reason: "columns-changed" });
    expect(profile.columnDiff!.changes[0]).toContain('"name" → "full_name"');
  });

  it("is partial when the patch fixes the rename but other regressions remain", async () => {
    const r = repo();
    r.write({ ...RENAME, "db/migrations/002_phone.sql": "ALTER TABLE customers ADD COLUMN phone text NOT NULL DEFAULT ''; ALTER TABLE customers ALTER COLUMN phone DROP DEFAULT;" });
    const res = await fix(r);
    expect(res.outcome).toBe("partial");
    expect(res.exitCode).toBe(1);
    expect(res.plan.verification!.stillFailing).toEqual(["signup"]);
  });

  it("is unsupported when the affected SQL uses an unsupported nested scope", async () => {
    const r = repo([{ id: "nested", category: "read", source: "sql/nested.sql" }], { "nested.sql": "SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders)" });
    r.write(RENAME);
    const res = await fix(r);
    expect(res.outcome).toBe("unsupported");
    expect(res.exitCode).toBe(1);
    expect(res.plan.refusals[0]!.reason).toContain("subqueries");
    expect(res.patch).toBe("");
  });

  it("is unsupported for failures that are not renames, and never edits inline SQL", async () => {
    const r = repo([...CHECKS, { id: "inline", category: "read", sql: "SELECT name FROM customers" }]);
    r.write(RENAME);
    const res = await fix(r);
    // Source-backed checks are fixed, the inline one is refused, so the result is partial.
    expect(res.outcome).toBe("partial");
    expect(res.plan.refusals.some((x) => x.checkIds.includes("inline") && x.reason.includes("inline SQL"))).toBe(true);

    const r2 = repo();
    r2.write({ "db/migrations/001.sql": "ALTER TABLE customers ADD COLUMN phone text NOT NULL DEFAULT 'x'; ALTER TABLE customers ALTER COLUMN phone DROP DEFAULT;" });
    const res2 = await fix(r2);
    expect(res2.outcome).toBe("unsupported");
    expect(res2.plan.refusals[0]!.reason).toContain("no explicit RENAME COLUMN");
  });

  it("is not needed when everything already passes", async () => {
    const r = repo();
    r.write({ "db/migrations/001.sql": "ALTER TABLE customers ADD COLUMN nickname text;" });
    const res = await fix(r);
    expect(res.outcome).toBe("not-needed");
    expect(res.exitCode).toBe(0);
    expect(res.plan.publishable).toBe(false);
  });

  it("does not fix failed migrations", async () => {
    const r = repo();
    r.write({ "db/migrations/001.sql": "ALTER TABLE nope RENAME COLUMN a TO b;" });
    const res = await fix(r);
    expect(res.outcome).toBe("unsupported");
    expect(res.plan.notes.join(" ")).toContain("migration failed");
  });

  describe("guardrails (apply to any proposer)", () => {
    const attempt = async (edit: (ctx: ProposalContext, r: TestRepo) => Proposal["edits"], checks = CHECKS, sql: Record<string, string> = SQL) => {
      const r = repo(checks, sql);
      r.write(RENAME);
      return fix(r, "main", undefined, { proposer: new FakeProposer((ctx) => edit(ctx, r)) });
    };

    it.each([
      ["the check manifest (deleting checks)", "checks.json"],
      ["the config", "crashpad.config.json"],
      ["seed data", "db/seed.sql"],
      ["a migration", "db/migrations/001_rename.sql"],
      ["a path outside the repository", "../outside.sql"],
      ["a file that backs no check", "README.md"],
    ])("refuses edits to %s", async (_what, p) => {
      const res = await attempt((_ctx, r) => [{ path: p, before: fs.existsSync(path.join(r.dir, p)) ? r.read(p) : "", after: "-- hacked\n", changes: [], checkIds: [] }]);
      expect(res.outcome).toBe("unsupported");
      expect(res.plan.refusals.some((x) => x.reason.startsWith("guardrail"))).toBe(true);
      expect(res.verification).toBeNull();
    });

    it("refuses edits to assertion fixtures (no weakening assertions)", async () => {
      const checks: CheckSpec[] = [...CHECKS, { id: "names-present", category: "assertion", source: "sql/names_present.sql" }];
      const res = await attempt(
        (ctx) => {
          const f = ctx.candidateFixtures.get("names-present")!;
          return [{ path: "sql/names_present.sql", before: f.sql, after: "SELECT true", changes: [], checkIds: ["names-present"] }];
        },
        checks,
        { ...SQL, "names_present.sql": "SELECT NOT EXISTS (SELECT 1 FROM customers WHERE name = '')" },
      );
      expect(res.outcome).toBe("unsupported");
      expect(res.plan.refusals.some((x) => x.reason.includes("assertion fixtures"))).toBe(true);
    });

    it("refuses a proposal whose 'before' text does not match the current source", async () => {
      const res = await attempt(() => [{ path: "sql/profile.sql", before: "SELECT stale", after: "SELECT 1", changes: [], checkIds: ["profile"] }]);
      expect(res.outcome).toBe("unsupported");
      expect(res.plan.refusals.some((x) => x.reason.includes("changed since"))).toBe(true);
    });
  });
});
