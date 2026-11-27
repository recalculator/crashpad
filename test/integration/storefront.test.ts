import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storefront } from "../fixtures/storefront/app.ts";
import { check, fix, g, tempDir, TestRepo } from "../helpers/project.ts";
import { buildScenarioRepo, loadScenarios } from "../helpers/scenario.ts";
import { createMigratedDatabase } from "../helpers/storefront-db.ts";

/** Exercises every operation of the fixture application, which runs the same SQL files Crashpad checks. */
async function exerciseApp(projectDir: string, pool: pg.Pool): Promise<void> {
  const app = storefront(projectDir);
  expect(await app.getCustomerProfile(pool, 1)).toEqual({ id: "1", email: "ada@example.test", name: "Ada Lovelace", order_count: "2", lifetime_spend: "180.47" });

  const s = await app.getOrderSummary(pool, 1);
  expect(s?.customerName).toBe("Ada Lovelace");
  expect(s?.greeting).toBe("Thanks for your order, Ada Lovelace");
  expect(s?.total).toBe("59.97");
  expect(s?.lines).toEqual([{ sku: "SKU-MUG", quantity: 3, unitPrice: "19.99", lineTotal: "59.97" }]);

  expect((await app.getCustomerOrders(pool, 2)).map((o) => o.id)).toEqual(["3", "4"]);

  const c = await app.signup(pool, { email: "test.signup@example.test", name: "Test Signup" });
  expect(c.name).toBe("Test Signup");
  expect((await app.getCustomerProfile(pool, Number(c.id)))?.name).toBe("Test Signup");

  expect(await app.renameCustomer(pool, 6, "Barbara L.")).toEqual({ id: "6", name: "Barbara L." });

  const o = await app.createOrder(pool, { customerId: 3, total: "42.50" });
  expect(o).toMatchObject({ status: "pending", total: "42.50" });
  expect(await app.markOrderPaid(pool, Number(o.id))).toBe(true);
  expect(await app.markOrderPaid(pool, Number(o.id))).toBe(false);
}

describe("storefront fixture application", () => {
  let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
  beforeAll(async () => {
    db = await createMigratedDatabase(path.resolve(import.meta.dirname, "../fixtures/storefront"));
  });
  afterAll(async () => db.drop());

  it("works against the fully migrated fixture database", async () => {
    await exerciseApp(path.resolve(import.meta.dirname, "../fixtures/storefront"), db.pool);
  });
});

describe("a verified rename fix restores the consuming application", () => {
  it("breaks the app before the fix and makes it work again after applying the patch", async () => {
    const scenario = loadScenarios().find((s) => s.name === "06-rename-fix")!;
    const repo = new TestRepo(buildScenarioRepo(scenario, tempDir()));
    const headBefore = repo.head();

    // Before the fix: the application's own queries fail on the migrated database.
    const broken = await createMigratedDatabase(repo.dir);
    try {
      await expect(storefront(repo.dir).getCustomerProfile(broken.pool, 1)).rejects.toMatchObject({ code: "42703" });
    } finally {
      await broken.drop();
    }

    // Crashpad proposes and verifies a patch without touching the checkout.
    const res = await fix(repo, "main");
    expect(res.outcome).toBe("verified");
    expect(g(repo.dir, "status", "--porcelain")).toBe("");
    expect(repo.head()).toBe(headBefore);

    // Apply the patch the way a developer would.
    const patchFile = path.join(tempDir(), "fix.patch");
    fs.writeFileSync(patchFile, res.patch);
    g(repo.dir, "apply", "--index", patchFile);

    const fixed = await createMigratedDatabase(repo.dir);
    try {
      await exerciseApp(repo.dir, fixed.pool);
    } finally {
      await fixed.drop();
    }
    expect((await check(repo, "main")).report.exitCode).toBe(0);
  });
});
