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
  it("parses dotenv examples and reports missing required variables (dotenv-safe semantics)", () => {
    const decls = parseDotenvExample("# c\nPORT=3000\nexport A='x y'\nB=\nC=\"q\\nr\" # trailing\nnot a var\n");
    expect(decls.map((d) => [d.name, d.example, d.line])).toEqual([["PORT", "3000", 2], ["A", "x y", 3], ["B", undefined, 4], ["C", "q\nr", 5]]);
    const schema: EnvSchema = { path: ".env.example", format: "dotenv-example", required: decls, examples: { PORT: "3000", A: "x y", C: "q\nr" } };
    const { env, appKeys } = buildTestEnv({ schema, useExampleValues: true, explicit: { C: "explicit" }, generated: { PORT: "4111" } });
    expect(appKeys).toEqual(["A", "C", "PORT"]);
    expect(env.PORT).toBe("4111");
    expect(env.C).toBe("explicit");
    expect(validateEnv(schema, { PORT: "1", A: "a", C: "c" }).map((i) => `${i.kind}:${i.name}`)).toEqual(["missing:B"]);
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
