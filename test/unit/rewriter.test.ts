import { beforeAll, describe, expect, it } from "vitest";
import { rewriteForRenames } from "../../src/fix/rewriter.ts";
import { detectRenames } from "../../src/fix/renames.ts";
import { ensureParser } from "../../src/sql/parser.ts";

beforeAll(() => ensureParser());

const catalog = {
  "public.customers": ["id", "email", "name", "created_at"],
  "public.orders": ["id", "customer_id", "total", "name_on_card"],
  "public.vendors": ["id", "name"],
};
const RENAME = [{ schema: "public", table: "customers", from: "name", to: "full_name", migration: "m.sql" }];

const rw = (sql: string, renames = RENAME, cat: Record<string, string[]> = catalog) => rewriteForRenames(sql, renames, cat);
const text = (sql: string, renames = RENAME) => {
  const r = rw(sql, renames);
  if (r.status !== "changed") throw new Error(`expected change, got ${r.status}${r.status === "refused" ? `: ${r.reason}` : ""}`);
  return r.text;
};
const refusal = (sql: string) => {
  const r = rw(sql);
  if (r.status !== "refused") throw new Error(`expected refusal, got ${r.status}`);
  return r.reason;
};

describe("identifier-aware rename rewriting", () => {
  it("preserves the response field name with an alias", () => {
    expect(text("SELECT name FROM customers")).toBe("SELECT full_name AS name FROM customers");
  });

  it("keeps an existing explicit alias", () => {
    expect(text("SELECT name AS customer FROM customers")).toBe("SELECT full_name AS customer FROM customers");
  });

  it("leaves string literals, comments, and parameters intact", () => {
    const sql = "-- name is shown on the page\nSELECT 'name' AS label, name /* name */ FROM customers WHERE name = $1 AND email <> 'name@x'";
    expect(text(sql)).toBe("-- name is shown on the page\nSELECT 'name' AS label, full_name AS name /* name */ FROM customers WHERE full_name = $1 AND email <> 'name@x'");
  });

  it("handles table aliases and qualified references", () => {
    expect(text("SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.name LIKE $1")).toBe(
      "SELECT c.full_name AS name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.full_name LIKE $1",
    );
    expect(text("SELECT customers.name FROM customers")).toBe("SELECT customers.full_name AS name FROM customers");
    expect(text("SELECT public.customers.name FROM public.customers")).toBe("SELECT public.customers.full_name AS name FROM public.customers");
  });

  it("does not touch same-named columns of other tables", () => {
    expect(text("SELECT c.name, v.name AS vendor FROM customers c JOIN vendors v ON v.id = c.id")).toBe(
      "SELECT c.full_name AS name, v.name AS vendor FROM customers c JOIN vendors v ON v.id = c.id",
    );
    expect(rw("SELECT name FROM vendors").status).toBe("unchanged");
    expect(rw("SELECT name_on_card FROM orders JOIN customers ON customers.id = orders.customer_id").status).toBe("unchanged");
  });

  it("rewrites quoted identifiers", () => {
    expect(text('SELECT "name" FROM "customers"')).toBe('SELECT full_name AS name FROM "customers"');
  });

  it("quotes a new name that needs quoting", () => {
    const r = [{ ...RENAME[0]!, to: "Full Name" }];
    expect(text("SELECT name FROM customers WHERE name = $1", r)).toBe('SELECT "Full Name" AS name FROM customers WHERE "Full Name" = $1');
    expect(text("SELECT name FROM customers", [{ ...RENAME[0]!, to: "user" }])).toBe('SELECT "user" AS name FROM customers');
  });

  it("maps PostgreSQL byte offsets correctly after multi-byte characters", () => {
    expect(text("SELECT 'café ☕ 🚀' AS x, name FROM customers -- é")).toBe("SELECT 'café ☕ 🚀' AS x, full_name AS name FROM customers -- é");
  });

  it("keeps ORDER BY references to output names, renames input references", () => {
    expect(text("SELECT name FROM customers ORDER BY name")).toBe("SELECT full_name AS name FROM customers ORDER BY name");
    expect(text("SELECT id FROM customers ORDER BY name")).toBe("SELECT id FROM customers ORDER BY full_name");
    expect(text("SELECT name AS n FROM customers ORDER BY name")).toBe("SELECT full_name AS n FROM customers ORDER BY full_name");
    expect(text("SELECT name, count(*) FROM customers GROUP BY name HAVING max(name) > ''")).toBe(
      "SELECT full_name AS name, count(*) FROM customers GROUP BY full_name HAVING max(full_name) > ''",
    );
  });

  it("rewrites expressions inside the select list without changing their output names", () => {
    expect(text("SELECT upper(name) AS shout, coalesce(name, 'n/a') FROM customers")).toBe(
      "SELECT upper(full_name) AS shout, coalesce(full_name, 'n/a') FROM customers",
    );
  });

  it("updates INSERT target columns and RETURNING", () => {
    expect(text("INSERT INTO customers (email, name) VALUES ($1, $2) RETURNING id, name")).toBe(
      "INSERT INTO customers (email, full_name) VALUES ($1, $2) RETURNING id, full_name AS name",
    );
  });

  it("updates UPDATE SET targets, values, and WHERE", () => {
    expect(text("UPDATE customers c SET name = upper(c.name) WHERE c.name <> $1")).toBe("UPDATE customers c SET full_name = upper(c.full_name) WHERE c.full_name <> $1");
  });

  it("handles DELETE … WHERE", () => {
    expect(text("DELETE FROM customers WHERE name = 'name'")).toBe("DELETE FROM customers WHERE full_name = 'name'");
  });

  it("leaves unrelated statements unchanged", () => {
    expect(rw("SELECT id, total FROM orders").status).toBe("unchanged");
    expect(rw("SELECT id, email FROM customers").status).toBe("unchanged");
  });

  it.each([
    ["subqueries", "SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders)"],
    ["CTEs", "WITH x AS (SELECT name FROM customers) SELECT name FROM x"],
    ["FROM subselects", "SELECT name FROM (SELECT name FROM customers) s"],
    ["UNION", "SELECT name FROM customers UNION SELECT name FROM vendors"],
    ["SELECT *", "SELECT * FROM customers"],
    ["qualified *", "SELECT c.* FROM customers c"],
    ["JOIN USING", "SELECT name FROM customers JOIN vendors USING (id)"],
    ["NATURAL JOIN", "SELECT id FROM customers NATURAL JOIN vendors"],
    ["ON CONFLICT", "INSERT INTO customers (email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name"],
    ["INSERT … SELECT", "INSERT INTO customers (email, name) SELECT 'a', 'b'"],
    ["casts without alias", "SELECT name::text FROM customers"],
    ["ambiguous unqualified column", "SELECT name FROM customers JOIN vendors ON vendors.id = customers.id"],
    ["tables missing from the baseline catalog", "SELECT name FROM customers JOIN mystery ON mystery.id = customers.id"],
    ["multiple statements", "SELECT name FROM customers; SELECT 1"],
  ])("refuses %s", (_what, sql) => {
    expect(refusal(sql)).toBeTruthy();
  });
});

describe("rename detection", () => {
  const m = (sql: string) => [{ name: "002.sql", path: "db/migrations/002.sql", sql }];

  it("finds explicit RENAME COLUMN statements", () => {
    expect(detectRenames(m("ALTER TABLE customers RENAME COLUMN name TO full_name;")).renames).toEqual([
      { schema: "public", table: "customers", from: "name", to: "full_name", migration: "db/migrations/002.sql" },
    ]);
    expect(detectRenames(m("ALTER TABLE shop.customers RENAME name TO full_name")).renames[0]?.schema).toBe("shop");
  });

  it("does not infer renames from drop/add pairs", () => {
    const r = detectRenames(m("ALTER TABLE customers ADD COLUMN full_name text; UPDATE customers SET full_name = name; ALTER TABLE customers DROP COLUMN name;"));
    expect(r.renames).toEqual([]);
  });

  it("refuses chained renames and re-added names", () => {
    expect(detectRenames(m("ALTER TABLE c RENAME COLUMN a TO b; ALTER TABLE c RENAME COLUMN b TO d;")).refusals).toHaveLength(1);
    expect(detectRenames(m("ALTER TABLE c RENAME COLUMN a TO b; ALTER TABLE c ADD COLUMN a text;")).refusals).toHaveLength(1);
    expect(detectRenames(m("ALTER TABLE c RENAME COLUMN a TO b; ALTER TABLE c DROP COLUMN b;")).refusals).toHaveLength(1);
  });
});
