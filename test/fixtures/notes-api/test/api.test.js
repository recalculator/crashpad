// The fixture application's own tests (run by Crashpad during repair verification).
// They need no database: they check request validation helpers only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("server requires its documented environment variables", () => {
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  for (const name of ["PORT", "DATABASE_URL", "SESSION_SECRET"]) assert.ok(src.includes(`"${name}"`), name);
});

test("the OpenAPI document declares a health endpoint", () => {
  assert.match(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"), /\/health:/);
});
