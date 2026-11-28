import { defineConfig } from "drizzle-kit";

// Applied with `drizzle-kit push`: there are no committed migrations.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
