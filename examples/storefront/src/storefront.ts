import { sql } from "./queries.ts";

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface CustomerProfile {
  id: string;
  email: string;
  name: string;
  order_count: string;
  lifetime_spend: string;
}

export interface OrderSummary {
  orderId: string;
  status: string;
  customerName: string;
  greeting: string;
  lines: Array<{ sku: string; quantity: number; unitPrice: string; lineTotal: string }>;
  total: string;
}

export class ValidationError extends Error {
  override name = "ValidationError";
}

/** Customer-profile operation (account page). */
export async function getCustomerProfile(db: Queryable, customerId: number): Promise<CustomerProfile | null> {
  const r = await db.query(sql("customer_profile"), [customerId]);
  return (r.rows[0] as CustomerProfile | undefined) ?? null;
}

/** Checkout / order-summary operation. */
export async function getOrderSummary(db: Queryable, orderId: number): Promise<OrderSummary | null> {
  const r = await db.query(sql("order_summary"), [orderId]);
  const first = r.rows[0];
  if (!first) return null;
  return {
    orderId: first.order_id,
    status: first.status,
    customerName: first.customer_name,
    greeting: first.greeting,
    lines: r.rows.map((row) => ({ sku: row.sku, quantity: row.quantity, unitPrice: row.unit_price, lineTotal: row.line_total })),
    total: first.order_total,
  };
}

export async function getCustomerOrders(db: Queryable, customerId: number): Promise<Array<{ id: string; status: string; total: string }>> {
  const r = await db.query(sql("customer_orders"), [customerId]);
  return r.rows.map((row) => ({ id: row.id, status: row.status, total: row.total }));
}

/** Customer signup. */
export async function signup(db: Queryable, input: { email: string; name: string }): Promise<{ id: string; email: string; name: string }> {
  if (!/^[^@\s]+@[^@\s]+$/.test(input.email)) throw new ValidationError("invalid email");
  if (!input.name.trim()) throw new ValidationError("name is required");
  const r = await db.query(sql("create_customer"), [input.email, input.name.trim()]);
  const row = r.rows[0];
  return { id: row.id, email: row.email, name: row.name };
}

export async function renameCustomer(db: Queryable, customerId: number, name: string): Promise<{ id: string; name: string } | null> {
  const r = await db.query(sql("update_customer_name"), [name, customerId]);
  return r.rows[0] ?? null;
}

/** Order creation at checkout. Totals are passed as strings to keep exact decimal precision. */
export async function createOrder(db: Queryable, input: { customerId: number; total: string }): Promise<{ id: string; status: string; total: string }> {
  if (!/^\d+(\.\d{1,2})?$/.test(input.total)) throw new ValidationError("total must be a non-negative decimal with at most 2 places");
  const r = await db.query(sql("create_order"), [input.customerId, input.total]);
  const row = r.rows[0];
  return { id: row.id, status: row.status, total: row.total };
}

export async function markOrderPaid(db: Queryable, orderId: number): Promise<boolean> {
  const r = await db.query(sql("mark_order_paid"), [orderId]);
  return r.rowCount === 1;
}
