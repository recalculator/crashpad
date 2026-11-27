import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const ROOT = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");

/**
 * Creates a throwaway database the same way the app's database would look after
 * deploy: bootstrap schema, sample data, then every migration in filename order.
 */
export async function createTestDatabase(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const serverUrl = process.env.CRASHPAD_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://localhost:5432/postgres";
  const name = `storefront_test_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await pool.query(read("db/schema.sql"));
  await pool.query(read("db/seed.sql"));
  const migrations = readdirSync(new URL("db/migrations/", ROOT)).filter((f) => f.endsWith(".sql")).sort();
  for (const m of migrations) await pool.query(read(`db/migrations/${m}`));
  return {
    pool,
    drop: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: serverUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
