import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { DB_URL } from "./project.ts";

/**
 * Creates a throwaway database the way the storefront's database looks after a
 * deploy of `projectDir`: bootstrap schema, sample data, then every migration in
 * filename order. Independent of Crashpad's own runner on purpose.
 */
export async function createMigratedDatabase(projectDir: string): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const read = (p: string) => readFileSync(path.join(projectDir, p), "utf8");
  const name = `storefront_test_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(DB_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await pool.query(read("db/schema.sql"));
  await pool.query(read("db/seed.sql"));
  const migrations = readdirSync(path.join(projectDir, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const m of migrations) await pool.query(read(`db/migrations/${m}`));
  return {
    pool,
    drop: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: DB_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
