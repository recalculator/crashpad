import { readFileSync } from "node:fs";

/**
 * The application runs the exact SQL files that Crashpad checks
 * (see crashpad.checks.json). There is no second copy of any query.
 */
const SQL_DIR = new URL("../sql/", import.meta.url);

const cache = new Map<string, string>();
export function sql(name: string): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(`${name}.sql`, SQL_DIR), "utf8");
    cache.set(name, text);
  }
  return text;
}
