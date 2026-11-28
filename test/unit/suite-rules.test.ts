import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diffSpecs, validateResponse, type LoadedSpec } from "../../src/engines/openapi.ts";
import { buildTestEnv, parseDotenvExample, validateEnv, type EnvSchema } from "../../src/engines/env.ts";
import { getPath, redactBody, template } from "../../src/engines/http.ts";
import { classifyRuntime } from "../../src/engines/runtime.ts";
import { suiteExitCode, type Finding } from "../../src/suite/types.ts";
import { mergeLayers } from "../../src/suite/config.ts";
import { discoverNode } from "../../src/discovery/node.ts";
import { FsSource } from "../../src/source.ts";
import { tempDir } from "../helpers/project.ts";

const ok = (schema: object) => ({ "200": { description: "ok", content: { "application/json": { schema } } } });
const spec = (paths: object) => ({ openapi: "3.0.3", info: { title: "t", version: "1" }, paths });
const user = { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" }, tags: { type: "array", items: { type: "string" } } } };

describe("OpenAPI breaking-change rules", () => {
  const base = spec({
    "/users/{id}": { get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok(user) } },
    "/users": {
      post: { requestBody: { content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, kind: { type: "string", enum: ["a", "b"] }, age: { type: "integer" } } } } } }, responses: ok(user) },
      get: { parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }], responses: ok({ type: "array", items: user }) },
    },
  });
  const rules = (cand: object) => diffSpecs(base, cand).changes.map((c) => `${c.operation} ${c.rule} ${c.location}`).sort();

  it("finds nothing for an identical or purely additive contract", () => {
    expect(diffSpecs(base, base).changes).toEqual([]);
    const additive = structuredClone(base) as any;
    additive.paths["/users/{userId}"] = additive.paths["/users/{id}"]; // renamed path parameter: same route
    delete additive.paths["/users/{id}"];
    additive.paths["/users/{userId}"].get.responses["200"].content["application/json"].schema.properties.email = { type: "string" };
    additive.paths["/health"] = { get: { responses: ok({ type: "object" }) } };
    additive.paths["/users"].post.requestBody.content["application/json"].schema.properties.nickname = { type: "string" };
    additive.paths["/users"].post.requestBody.content["application/json"].schema.properties.age = { type: "number" }; // widening
    expect(diffSpecs(base, additive).changes).toEqual([]);
  });

  it("reports removed operations, required inputs, and request type/enum changes", () => {
    const c = structuredClone(base) as any;
    delete c.paths["/users/{id}"];
    c.paths["/users"].get.parameters = [{ name: "limit", in: "query", required: true, schema: { type: "string" } }, { name: "x-tenant", in: "header", required: true, schema: { type: "string" } }];
    c.paths["/users"].post.requestBody.required = true;
    const body = c.paths["/users"].post.requestBody.content["application/json"].schema;
    body.required = ["name", "email"];
    body.properties.kind.enum = ["a"];
    body.properties.name = { type: "integer" };
    expect(rules(c)).toEqual([
      "GET /users new-required-parameter parameters/header:x-tenant",
      "GET /users new-required-parameter parameters/query:limit",
      "GET /users parameter-type-changed parameters/query:limit",
      "GET /users/{} removed-operation ",
      "POST /users new-required-request-field /email",
      "POST /users request-body-required requestBody",
      "POST /users request-enum-narrowed /kind",
      "POST /users request-field-type-changed /name",
    ]);
  });

  it("reports removed, retyped, optional, and nullable response fields, including inside arrays", () => {
    const c = structuredClone(base) as any;
    const s = c.paths["/users/{id}"].get.responses["200"].content["application/json"].schema;
    delete s.properties.tags;
    s.properties.id = { type: "string" };
    s.required = ["id"];
    s.properties.name.nullable = true;
    c.paths["/users"].get.responses["200"].content["application/json"].schema.items = { type: "object", properties: { id: { type: "integer" } } };
    c.paths["/users"].post.responses = { "202": { description: "accepted" } };
    expect(rules(c)).toEqual([
      "GET /users removed-response-field responses/200[]/name",
      "GET /users removed-response-field responses/200[]/tags",
      "GET /users response-field-optional responses/200[]/id",
      "GET /users/{} removed-response-field responses/200/tags",
      "GET /users/{} response-field-nullable responses/200/name",
      "GET /users/{} response-field-optional responses/200/name",
      "GET /users/{} response-field-type-changed responses/200/id",
      "POST /users removed-response-status responses/200",
    ]);
  });

  it("validates runtime responses against the baseline schema, with OpenAPI 3.0 nullable", () => {
    const loaded: LoadedSpec = { path: "openapi.yaml", version: "3.0", doc: spec({ "/u/{id}": { get: { responses: ok({ type: "object", required: ["id"], properties: { id: { type: "integer" }, note: { type: "string", nullable: true } } }) } } }) };
    expect(validateResponse(loaded, "GET", "/u/7", 200, "application/json", { id: 1, note: null }).ok).toBe(true);
    const bad = validateResponse(loaded, "GET", "/u/7?x=1", 200, "application/json", { note: 3 });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/id/);
    expect(validateResponse(loaded, "GET", "/u/7", 500, "application/json", {}).errors[0]).toMatch(/not documented/);
    expect(validateResponse(loaded, "GET", "/nope", 200, "application/json", {}).operation).toBeNull();
  });
});

describe("environment contracts", () => {
  it("parses dotenv examples as declarations: blank values are never reported as missing", () => {
    const text = "# c\nPORT=3000\nexport A='x y'\nB=\nC=\"q\\nr\" # trailing\nnot a var\n# WILLO_PORT=8787\n# just a comment = here\n";
    const decls = parseDotenvExample(text);
    expect(decls.map((d) => [d.name, d.example, d.line])).toEqual([["PORT", "3000", 2], ["A", "x y", 3], ["B", undefined, 4], ["C", "q\nr", 5]]);
    expect(parseDotenvExample(text, { commented: true }).map((d) => d.name)).toEqual(["PORT", "A", "B", "C", "WILLO_PORT"]);
    const schema: EnvSchema = { path: ".env.example", format: "dotenv-example", required: [], declared: decls, examples: { PORT: "3000", A: "x y", C: "q\nr" } };
    const { env, appKeys } = buildTestEnv({ schema, useExampleValues: true, explicit: { C: "explicit" }, generated: { PORT: "4111" } });
    expect(appKeys).toEqual(["A", "C", "PORT"]);
    expect(env.PORT).toBe("4111");
    expect(env.C).toBe("explicit");
    // B has no value anywhere: a dotenv example cannot say it is required, so it is not a violation.
    expect(validateEnv(schema, { PORT: "1", A: "a", C: "c" })).toEqual([]);
  });

  it("never passes the caller's environment through, apart from tool variables", () => {
    process.env.CRASHPAD_TEST_PRODUCTION_SECRET = "do-not-copy";
    const { env } = buildTestEnv({ schema: null, useExampleValues: true, explicit: {}, generated: {} });
    expect(env.CRASHPAD_TEST_PRODUCTION_SECRET).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    delete process.env.CRASHPAD_TEST_PRODUCTION_SECRET;
  });

  it("validates values against a JSON Schema with string coercion", () => {
    const schema: EnvSchema = {
      path: "env.schema.json",
      format: "json-schema",
      required: [{ name: "PORT", line: 1 }],
      declared: [{ name: "PORT", line: 1 }],
      examples: {},
      jsonSchema: { type: "object", required: ["PORT"], properties: { PORT: { type: "integer" }, LOG_LEVEL: { enum: ["debug", "info"] }, API_TOKEN: { minLength: 30 } } },
    };
    const issues = validateEnv(schema, { PORT: "80a", LOG_LEVEL: "loud", API_TOKEN: "short-secret" });
    expect(issues.map((i) => `${i.kind}:${i.name}`)).toEqual(["invalid:PORT", "invalid:LOG_LEVEL", "invalid:API_TOKEN"]);
    expect(issues[2]!.message).not.toContain("short-secret");
    expect(validateEnv(schema, { PORT: "8080", LOG_LEVEL: "info" })).toEqual([]);
  });
});

describe("HTTP scenario helpers", () => {
  it("templates values, keeping types for whole placeholders and URL-encoding paths", () => {
    const vars = { id: 7, name: "a b", "alice.token": "t" };
    expect(template({ x: "{{id}}", y: "n={{name}}", z: ["{{alice.token}}"] }, vars)).toEqual({ x: 7, y: "n=a b", z: ["t"] });
    expect(template("/u/{{name}}", vars, true)).toBe("/u/a%20b");
    expect(() => template("{{missing}}", vars)).toThrow(/unknown variable/);
    expect(getPath({ a: [{ b: 1 }] }, "a.0.b")).toBe(1);
  });

  it("redacts credential-like fields in recorded bodies", () => {
    expect(redactBody('{"token":"abc","user":{"password":"p","name":"n"}}')).toBe('{"token":"***","user":{"password":"***","name":"n"}}');
    expect(redactBody("Authorization: Bearer abc.def")).toBe("Authorization: Bearer ***");
  });
});

describe("decision rules shared by every area", () => {
  const pass = { status: "pass" as const, summary: "", evidence: [] };
  const fail = { status: "fail" as const, summary: "x", evidence: [] };
  it("classifies runtime outcomes like the database engine", () => {
    expect(classifyRuntime(pass, pass).classification).toBe("pass");
    expect(classifyRuntime(pass, fail).classification).toBe("regression");
    expect(classifyRuntime(fail, fail).classification).toBe("baseline-failure");
    expect(classifyRuntime(fail, pass).classification).toBe("baseline-failure");
    expect(classifyRuntime(null, fail).classification).toBe("regression");
    expect(classifyRuntime(null, pass).classification).toBe("pass");
    expect(classifyRuntime(pass, { status: "error", summary: "", evidence: [], crashed: true }).classification).toBe("regression");
    expect(classifyRuntime(pass, { status: "error", summary: "", evidence: [], crashed: false }).classification).toBe("inconclusive");
    expect(classifyRuntime(pass, { status: "not-run", summary: "", evidence: [], startupFailed: true }).classification).toBe("skipped");
    expect(classifyRuntime({ status: "not-run", summary: "", evidence: [], startupFailed: true }, pass).classification).toBe("baseline-failure");
  });

  it("never reports success when nothing was verified", () => {
    const f = (classification: Finding["classification"]) => ({ classification }) as Finding;
    expect(suiteExitCode({ problems: [], findings: [], coverage: [] })).toBe(2);
    expect(suiteExitCode({ problems: [], findings: [f("skipped")], coverage: [] })).toBe(2);
    expect(suiteExitCode({ problems: [], findings: [f("pass")], coverage: [] })).toBe(0);
    expect(suiteExitCode({ problems: [], findings: [f("pass"), f("inconclusive")], coverage: [] })).toBe(2);
    expect(suiteExitCode({ problems: [], findings: [f("pass"), f("regression"), f("inconclusive")], coverage: [] })).toBe(1);
    expect(suiteExitCode({ problems: [{ kind: "config", message: "x" }], findings: [f("regression")], coverage: [] })).toBe(2);
  });

  it("merges configuration layers with later layers winning and arrays replaced", () => {
    expect(mergeLayers({ app: { start: ["a"], env: { A: "1" } } }, { app: { env: { B: "2" } } }, { app: { start: ["b", "c"] } })).toEqual({ app: { start: ["b", "c"], env: { A: "1", B: "2" } } });
  });
});

describe("discovery rules (Node.js / PostgreSQL)", () => {
  const project = (files: Record<string, string>) => {
    const dir = tempDir();
    for (const [p, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), c);
    }
    return discoverNode(new FsSource(dir), ".");
  };
  const msgs = (d: Awaited<ReturnType<typeof project>>) => d.missing.map((m) => `${m.area}: ${m.message}`).join("\n");

  it("discovers package manager, scripts, Prisma migrations, spec, env schema, and health path", async () => {
    const d = await project({
      "package.json": JSON.stringify({ scripts: { start: "node dist/server.js", build: "tsc", test: "vitest run", typecheck: "tsc --noEmit" }, dependencies: { "@prisma/client": "5" } }),
      "pnpm-lock.yaml": "lockfileVersion: 9",
      "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}',
      "prisma/migrations/20240101000000_init/migration.sql": "CREATE TABLE t (id int);",
      "openapi.yaml": "openapi: 3.1.0\ninfo: {title: t, version: '1'}\npaths:\n  /healthz:\n    get:\n      responses: {'200': {description: ok}}\n",
      ".env.example": "POSTGRES_URL=\nPORT=3000\n",
    });
    expect(d.layer.app).toMatchObject({ install: ["pnpm", "install", "--frozen-lockfile"], build: ["pnpm", "run", "build"], start: ["pnpm", "run", "start"], readiness: { path: "/healthz" }, databaseUrlEnv: "POSTGRES_URL", envSchema: { path: ".env.example", format: "dotenv-example" } });
    expect(d.layer.database).toMatchObject({ migrations: "prisma/migrations", migrationFormat: "prisma" });
    expect(d.layer.tests).toEqual([["pnpm", "run", "typecheck"], ["pnpm", "run", "test"]]);
    expect(d.layer.api).toEqual({ openapi: "openapi.yaml" });
    expect(msgs(d)).toMatch(/permissions: no permission scenarios/);
  });

  it("explains Postgres projects without migration history and finds the port variable (real-project trial)", async () => {
    // Shaped like the trial's Next.js + Drizzle project, whose schema is applied with drizzle-kit push.
    const drizzleConfig = 'import { defineConfig } from "drizzle-kit";\nexport default defineConfig({\n  schema: "./src/db/schema.ts",\n  out: "./drizzle",\n  dialect: "postgresql",\n  dbCredentials: { url: process.env.DATABASE_URL! },\n});\n';
    const drizzlePkg = JSON.stringify({ scripts: { start: "next start", "db:push": "drizzle-kit push" }, dependencies: { postgres: "3", "drizzle-orm": "0" }, devDependencies: { "drizzle-kit": "0" } });
    const drizzle = await project({ "package.json": drizzlePkg, "drizzle.config.ts": drizzleConfig, "src/db/schema.ts": "export {}", ".env.example": "DATABASE_URL=\nPORT=3000\n" });
    expect(drizzle.layer.database).toBeUndefined();
    // No migration history: the schema module is used for schema compatibility, and the fact says so.
    expect(drizzle.layer.orm).toEqual({ kind: "drizzle", schema: "src/db/schema.ts" });
    expect(drizzle.facts.join("\n")).toMatch(/Drizzle ORM schema: src\/db\/schema.ts \(from drizzle.config.ts\)[\s\S]*SCHEMA COMPATIBILITY[\s\S]*not a migration sequence/);
    expect(msgs(drizzle)).not.toMatch(/database:/);
    // Shapes Crashpad does not read are reported, never guessed.
    const glob = await project({ "package.json": drizzlePkg, "drizzle.config.ts": drizzleConfig.replace("./src/db/schema.ts", "./src/db/*.ts") });
    expect(glob.missing.find((m) => m.key === "orm.schema")?.message).toMatch(/is a glob/);
    const arr = await project({ "package.json": drizzlePkg, "drizzle.config.ts": 'export default { schema: ["./a.ts", "./b.ts"], dialect: "postgresql" }' });
    expect(arr.missing.find((m) => m.key === "orm.schema")?.message).toMatch(/it is an array/);
    const dirSchema = await project({ "package.json": drizzlePkg, "drizzle.config.ts": drizzleConfig.replace("./src/db/schema.ts", "./src/db"), "src/db/a.ts": "" });
    expect(dirSchema.missing.find((m) => m.key === "orm.schema")?.message).toMatch(/not a file/);
    const noKit = await project({ "package.json": JSON.stringify({ dependencies: { "drizzle-orm": "0" } }), "drizzle.config.ts": drizzleConfig, "src/db/schema.ts": "" });
    expect(noKit.missing.find((m) => m.key === "orm.schema")?.message).toMatch(/drizzle-kit is not a dependency/);
    const mysql = await project({ "package.json": drizzlePkg, "drizzle.config.ts": drizzleConfig.replace("postgresql", "mysql"), "src/db/schema.ts": "" });
    expect(msgs(mysql)).toMatch(/uses dialect mysql; only PostgreSQL/);
    expect(drizzle.facts).toContain("port variable: PORT (declared in the environment example)");
    expect(msgs(drizzle)).toContain("no health endpoint is known (there is no OpenAPI document)");
    // Shaped like the trial's Hono app: the port variable is only a commented default.
    const custom = await project({ "package.json": JSON.stringify({ scripts: { start: "tsx src/server/main.ts" } }), ".env.example": "API_KEY=\n# APP_PORT=8787\n# DB_PORT=5432\n" });
    expect((custom.layer.app as { portEnv?: string }).portEnv).toBe("APP_PORT");
    const none = await project({ "package.json": JSON.stringify({ scripts: { start: "node s.js" } }), ".env.example": "API_KEY=\n" });
    expect(none.missing.find((m) => m.key === "app.portEnv")?.message).toMatch(/assumes the server reads PORT/);
    const two = await project({ "package.json": JSON.stringify({ scripts: { start: "node s.js" } }), ".env.example": "WEB_PORT=1\nADMIN_PORT=2\n" });
    expect(two.missing.find((m) => m.key === "app.portEnv")?.message).toMatch(/several port variables/);
    const pg = await project({ "package.json": JSON.stringify({ dependencies: { pg: "8" } }) });
    expect(msgs(pg)).toMatch(/a PostgreSQL client \(pg\) is a dependency, but no SQL migrations/);
  });

  it("explains exactly what is unsupported instead of guessing", async () => {
    expect(msgs(await project({ "package.json": "{}", "db/migrations/001.sql": "-- migrate:up\nCREATE TABLE t();\n-- migrate:down\nDROP TABLE t;" }))).toMatch(/dbmate-style/);
    expect(msgs(await project({ "package.json": "{}", "migrations/001_init.js": "exports.up = () => {}" }))).toMatch(/JavaScript\/TypeScript migrations/);
    expect(msgs(await project({ "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}', "bun.lock": "" }))).toMatch(/Bun projects are not supported[\s\S]*no "start" script/);
    const noPkg = await project({ "migrations/001.sql": "CREATE TABLE t();", "db/schema.sql": "CREATE TABLE t();" });
    expect(msgs(noPkg)).toMatch(/no package.json[\s\S]*did not use it as the bootstrap schema/);
    expect(noPkg.layer.database).toMatchObject({ migrations: "migrations" });
    expect((await project({ "package.json": "{}", "prisma/schema.prisma": 'datasource db {\n provider = "mysql"\n}', "prisma/migrations/1_x/migration.sql": "" })).missing.some((m) => /only PostgreSQL/.test(m.message))).toBe(true);
  });
});

describe("onboarding rules from the second real-project trial (Next.js + Drizzle push)", () => {
  it("never takes the database URL from a committed example, for any command", () => {
    const schema: EnvSchema = { path: ".env.example", format: "dotenv-example", required: [], declared: [], examples: { DATABASE_URL: "postgresql://u:p@db.example.com/app", ANTHROPIC_API_KEY: "sk-ant-..." } };
    const { env } = buildTestEnv({ schema, useExampleValues: true, explicit: {}, generated: { CI: "1" }, neverFromExamples: ["DATABASE_URL"] });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-...");
    // Crashpad's throwaway database still wins when there is one.
    expect(buildTestEnv({ schema, useExampleValues: true, explicit: {}, generated: { DATABASE_URL: "postgres://localhost/crashpad_x" }, neverFromExamples: ["DATABASE_URL"] }).env.DATABASE_URL).toBe("postgres://localhost/crashpad_x");
  });

  it("classifies the project's own commands relative to the baseline", async () => {
    const { classifyCommand } = await import("../../src/engines/project-commands.ts");
    const pass = { status: "pass" as const, summary: "passed", exitCode: 0 };
    const fail = { status: "fail" as const, summary: "failed (exit 1)", exitCode: 1 };
    const notRun = { status: "not-run" as const, summary: "install failed", exitCode: null };
    expect(classifyCommand(pass, pass).classification).toBe("pass");
    expect(classifyCommand(pass, fail).classification).toBe("broken");
    expect(classifyCommand(fail, fail).classification).toBe("failing-at-baseline");
    expect(classifyCommand(fail, pass).classification).toBe("fixed");
    expect(classifyCommand(notRun, fail).classification).toBe("undecided");
    expect(classifyCommand(pass, notRun).classification).toBe("undecided");
    // Only a command the change broke is actionable, and it never counts as a Crashpad check.
    const report = { problems: [], findings: [], coverage: [] };
    const cmd = (classification: "broken" | "failing-at-baseline") => ({ headline: "", missing: [], results: [{ command: "npm run build", role: "build" as const, classification, message: "", baseline: pass, candidate: fail }] });
    expect(suiteExitCode({ ...report, projectCommands: cmd("broken") })).toBe(1);
    expect(suiteExitCode({ ...report, projectCommands: cmd("failing-at-baseline") })).toBe(2);
  });

  it("knows that `next start` reads PORT", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: "next start", build: "next build" } }));
    fs.writeFileSync(path.join(dir, ".env.example"), "ANTHROPIC_API_KEY=sk-ant-...\n");
    const d = await discoverNode(new FsSource(dir), ".");
    expect(d.facts).toContain("port variable: PORT (`next start` reads it)");
    expect(d.missing.some((m) => m.key === "app.portEnv")).toBe(false);
  });
});
