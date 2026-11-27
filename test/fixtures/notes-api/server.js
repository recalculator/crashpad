// Notes API used as a Crashpad test fixture. Plain Node.js + PostgreSQL, no framework.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import pg from "pg";

const required = ["PORT", "DATABASE_URL", "SESSION_SECRET"];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const sql = (name) => readFileSync(new URL(`./sql/${name}.sql`, import.meta.url), "utf8");
const SECRET = process.env.SESSION_SECRET;

const hashPassword = (pw) => createHash("sha256").update(`crashpad-fixture:${pw}`).digest("hex");
const sign = (id) => createHmac("sha256", SECRET).update(String(id)).digest("hex");
const tokenFor = (id) => `${id}.${sign(id)}`;

async function currentUser(req) {
  const m = (req.headers.authorization ?? "").match(/^Bearer (\d+)\.([0-9a-f]{64})$/);
  if (!m) return null;
  const expected = Buffer.from(sign(m[1]), "hex");
  if (!timingSafeEqual(expected, Buffer.from(m[2], "hex"))) return null;
  const r = await pool.query("SELECT id::text, email, name, role FROM users WHERE id = $1", [m[1]]);
  return r.rows[0] ?? null;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const noteOut = (n) => ({ id: String(n.id), ownerId: String(n.owner_id), title: n.title, body: n.body });

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const method = req.method;

  if (method === "GET" && path === "/health") return send(res, 200, { ok: true });

  if (method === "GET" && path === "/products") {
    const r = await pool.query(sql("list_products"));
    return send(res, 200, r.rows.map((p) => ({ id: Number(p.id), name: p.name, price: p.price })));
  }

  if (method === "POST" && path === "/signup") {
    const b = await readJson(req);
    if (!b || typeof b.email !== "string" || typeof b.password !== "string" || typeof b.name !== "string") return send(res, 400, { error: "email, password, and name are required" });
    try {
      const r = await pool.query("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id::text, email, name", [b.email, b.name, hashPassword(b.password)]);
      return send(res, 201, r.rows[0]);
    } catch (err) {
      if (err.code === "23505") return send(res, 409, { error: "email already registered" });
      throw err;
    }
  }

  if (method === "POST" && path === "/login") {
    const b = await readJson(req);
    if (!b || typeof b.email !== "string" || typeof b.password !== "string") return send(res, 400, { error: "email and password are required" });
    const r = await pool.query("SELECT id::text FROM users WHERE email = $1 AND password_hash = $2", [b.email, hashPassword(b.password)]);
    if (!r.rows[0]) return send(res, 401, { error: "invalid credentials" });
    return send(res, 200, { token: tokenFor(r.rows[0].id) });
  }

  const user = await currentUser(req);

  if (method === "GET" && path === "/me") {
    if (!user) return send(res, 401, { error: "authentication required" });
    return send(res, 200, { id: user.id, email: user.email, name: user.name, role: user.role });
  }

  if (method === "GET" && path === "/admin/users") {
    if (!user) return send(res, 401, { error: "authentication required" });
    if (user.role !== "admin") return send(res, 403, { error: "admin only" });
    const r = await pool.query("SELECT id::text, email, role FROM users ORDER BY id");
    return send(res, 200, r.rows);
  }

  if (method === "POST" && path === "/notes") {
    if (!user) return send(res, 401, { error: "authentication required" });
    const b = await readJson(req);
    if (!b || typeof b.title !== "string") return send(res, 400, { error: "title is required" });
    const r = await pool.query(sql("create_note"), [user.id, b.title, typeof b.body === "string" ? b.body : ""]);
    await pool.query("INSERT INTO audit_log (actor_id, action, subject_id) VALUES ($1, 'note.created', $2)", [user.id, r.rows[0].id]);
    return send(res, 201, noteOut(r.rows[0]));
  }

  const noteMatch = path.match(/^\/notes\/(\d+)$/);
  if (noteMatch) {
    if (!user) return send(res, 401, { error: "authentication required" });
    const r = await pool.query("SELECT id, owner_id, title, body FROM notes WHERE id = $1", [noteMatch[1]]);
    const note = r.rows[0];
    // Owners and admins may see a note; for anyone else it does not exist.
    if (!note || (String(note.owner_id) !== user.id && user.role !== "admin")) return send(res, 404, { error: "not found" });
    if (method === "GET") return send(res, 200, noteOut(note));
    if (method === "PATCH") {
      if (String(note.owner_id) !== user.id) return send(res, 403, { error: "only the owner can edit" });
      const b = await readJson(req);
      if (!b || typeof b.title !== "string") return send(res, 400, { error: "title is required" });
      const u = await pool.query("UPDATE notes SET title = $1, updated_at = now() WHERE id = $2 RETURNING id, owner_id, title, body", [b.title, note.id]);
      await pool.query("INSERT INTO audit_log (actor_id, action, subject_id) VALUES ($1, 'note.updated', $2)", [user.id, note.id]);
      return send(res, 200, noteOut(u.rows[0]));
    }
  }

  return send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  });
});

server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`notes-api listening on ${process.env.PORT}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
