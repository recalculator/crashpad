import http from "node:http";
import fs from "node:fs";
import pg from "pg";

if (!fs.existsSync("dist/built.txt")) throw new Error("not built");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
// Fails at startup if the schema it needs is missing.
await client.query("SELECT count(*) FROM projects");
http
  .createServer(async (req, res) => {
    const r = await client.query("SELECT id, name, stage FROM projects ORDER BY created_at");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(r.rows));
  })
  .listen(Number(process.env.PORT ?? 3000));
