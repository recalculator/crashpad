import http from "node:http";
import pg from "pg";
import { createOrder, getCustomerOrders, getCustomerProfile, getOrderSummary, signup, ValidationError } from "./storefront.ts";

/** Minimal JSON HTTP API over the storefront operations. */
export function createServer(db: pg.Pool): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let m: RegExpMatchArray | null;
      if (req.method === "GET" && (m = url.pathname.match(/^\/customers\/(\d+)$/))) {
        const p = await getCustomerProfile(db, Number(m[1]));
        return p ? send(200, p) : send(404, { error: "not found" });
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/customers\/(\d+)\/orders$/))) {
        return send(200, await getCustomerOrders(db, Number(m[1])));
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/orders\/(\d+)\/summary$/))) {
        const s = await getOrderSummary(db, Number(m[1]));
        return s ? send(200, s) : send(404, { error: "not found" });
      }
      if (req.method === "POST" && (url.pathname === "/customers" || url.pathname === "/orders")) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (url.pathname === "/customers") return send(201, await signup(db, body));
        return send(201, await createOrder(db, body));
      }
      send(404, { error: "not found" });
    } catch (err) {
      if (err instanceof ValidationError || err instanceof SyntaxError) return send(400, { error: err.message });
      send(500, { error: "internal error" });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const port = Number(process.env.PORT ?? 3000);
  createServer(pool).listen(port, () => console.log(`storefront listening on http://localhost:${port}`));
}
