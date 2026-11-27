import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * A minimal application layer over the storefront fixture. It runs the exact
 * `sql/*.sql` files that `crashpad.checks.json` points at, loaded from the given
 * project directory, so tests can run the "application" against an original or
 * a patched checkout and see what a real consumer of those files would see.
 */

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export const FIXTURE_DIR = import.meta.dirname;

export function storefront(projectDir: string = FIXTURE_DIR) {
  const cache = new Map<string, string>();
  const sql = (name: string): string => {
    let text = cache.get(name);
    if (text === undefined) {
      text = readFileSync(path.join(projectDir, "sql", `${name}.sql`), "utf8");
      cache.set(name, text);
    }
    return text;
  };

  return {
    async getCustomerProfile(db: Queryable, customerId: number) {
      const r = await db.query(sql("customer_profile"), [customerId]);
      return (r.rows[0] as { id: string; email: string; name: string; order_count: string; lifetime_spend: string } | undefined) ?? null;
    },

    async getOrderSummary(db: Queryable, orderId: number) {
      const r = await db.query(sql("order_summary"), [orderId]);
      const first = r.rows[0];
      if (!first) return null;
      return {
        orderId: first.order_id as string,
        status: first.status as string,
        customerName: first.customer_name as string,
        greeting: first.greeting as string,
        lines: r.rows.map((row) => ({ sku: row.sku, quantity: row.quantity, unitPrice: row.unit_price, lineTotal: row.line_total })),
        total: first.order_total as string,
      };
    },

    async getCustomerOrders(db: Queryable, customerId: number) {
      const r = await db.query(sql("customer_orders"), [customerId]);
      return r.rows.map((row) => ({ id: row.id as string, status: row.status as string, total: row.total as string }));
    },

    async signup(db: Queryable, input: { email: string; name: string }) {
      const r = await db.query(sql("create_customer"), [input.email, input.name]);
      const row = r.rows[0];
      return { id: row.id as string, email: row.email as string, name: row.name as string };
    },

    async renameCustomer(db: Queryable, customerId: number, name: string) {
      const r = await db.query(sql("update_customer_name"), [name, customerId]);
      return (r.rows[0] as { id: string; name: string } | undefined) ?? null;
    },

    async createOrder(db: Queryable, input: { customerId: number; total: string }) {
      const r = await db.query(sql("create_order"), [input.customerId, input.total]);
      const row = r.rows[0];
      return { id: row.id as string, status: row.status as string, total: row.total as string };
    },

    async markOrderPaid(db: Queryable, orderId: number) {
      const r = await db.query(sql("mark_order_paid"), [orderId]);
      return r.rowCount === 1;
    },
  };
}
