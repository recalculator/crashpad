import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { createServer } from "../src/server.ts";
import { createOrder, getCustomerOrders, getCustomerProfile, getOrderSummary, markOrderPaid, renameCustomer, signup } from "../src/storefront.ts";
import { createTestDatabase } from "./helpers.ts";

describe("storefront against a fully migrated database", () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  before(async () => ({ pool, drop } = await createTestDatabase()));
  after(async () => drop());

  it("customer profile returns the name field", async () => {
    const p = await getCustomerProfile(pool, 1);
    assert.deepEqual(p, { id: "1", email: "ada@example.test", name: "Ada Lovelace", order_count: "2", lifetime_spend: "180.47" });
  });

  it("order summary includes the customer name and exact totals", async () => {
    const s = await getOrderSummary(pool, 1);
    assert.ok(s);
    assert.equal(s.customerName, "Ada Lovelace");
    assert.equal(s.greeting, "Thanks for your order, Ada Lovelace");
    assert.equal(s.total, "59.97");
    assert.deepEqual(s.lines, [{ sku: "SKU-MUG", quantity: 3, unitPrice: "19.99", lineTotal: "59.97" }]);
  });

  it("customer orders are returned in order", async () => {
    assert.deepEqual((await getCustomerOrders(pool, 2)).map((o) => o.id), ["3", "4"]);
  });

  it("signup creates a customer and returns the name field", async () => {
    const c = await signup(pool, { email: "test.signup@example.test", name: "Test Signup" });
    assert.equal(c.name, "Test Signup");
    const p = await getCustomerProfile(pool, Number(c.id));
    assert.equal(p?.name, "Test Signup");
  });

  it("profile edit updates the name", async () => {
    assert.deepEqual(await renameCustomer(pool, 6, "Barbara L."), { id: "6", name: "Barbara L." });
  });

  it("order creation and payment", async () => {
    const o = await createOrder(pool, { customerId: 3, total: "42.50" });
    assert.equal(o.status, "pending");
    assert.equal(o.total, "42.50");
    assert.equal(await markOrderPaid(pool, Number(o.id)), true);
    assert.equal(await markOrderPaid(pool, Number(o.id)), false);
  });

  it("HTTP API serves the profile and signup", async () => {
    const server = createServer(pool);
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      const profile = (await (await fetch(`http://localhost:${port}/customers/2`)).json()) as { name: string };
      assert.equal(profile.name, "Grace Hopper");
      const created = await fetch(`http://localhost:${port}/customers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "http.signup@example.test", name: "Http Signup" }),
      });
      assert.equal(created.status, 201);
      assert.equal(((await created.json()) as { name: string }).name, "Http Signup");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
