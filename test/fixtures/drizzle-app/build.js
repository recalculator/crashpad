// Like a framework build that imports server modules: it needs a database URL.
import fs from "node:fs";
if (!process.env.DATABASE_URL) {
  console.error("Error: DATABASE_URL is not set");
  process.exit(1);
}
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/built.txt", "ok\n");
