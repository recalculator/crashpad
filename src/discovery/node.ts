import { parse as parseYaml } from "yaml";
import { projectPath } from "../paths.ts";
import type { Source } from "../source.ts";
import type { Discovery } from "../suite/runner.ts";
import type { Area } from "../suite/types.ts";
import { parseDotenvExample } from "../engines/env.ts";

/**
 * Discovery for ONE supported stack: Node.js / TypeScript applications backed by
 * PostgreSQL. Each rule below is explicit and checks for a concrete file or field;
 * nothing is guessed from naming alone. What cannot be discovered is reported in
 * `missing` with the exact requirement.
 */

export const DISCOVERY_RULES_VERSION = 2;

export interface NodeFacts {
  packageManager: "npm" | "pnpm" | "yarn" | null;
  lockfile: string | null;
  scripts: Record<string, string>;
  postgresClient: string | null;
}

const LOCKFILES: Array<[string, NodeFacts["packageManager"]]> = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

const PG_CLIENTS = ["pg", "postgres", "pg-promise", "@neondatabase/serverless", "@vercel/postgres", "slonik"];
const SQL_MIGRATION_DIRS = ["db/migrations", "migrations", "sql/migrations", "database/migrations"];
const SCHEMA_FILES = ["db/schema.sql", "schema.sql", "db/structure.sql", "database/schema.sql"];
const SEED_FILES = ["db/seed.sql", "seed.sql", "db/seeds.sql", "database/seed.sql"];
const SPEC_FILES = ["openapi.yaml", "openapi.yml", "openapi.json", "openapi/openapi.yaml", "openapi/openapi.json", "api/openapi.yaml", "api/openapi.json", "docs/openapi.yaml", "docs/openapi.json", "spec/openapi.yaml", "spec/openapi.json"];
const ENV_DOTENV = [".env.example", ".env.sample", ".env.template", "env.example"];
const ENV_JSON = ["env.schema.json", ".env.schema.json"];
const HEALTH_PATHS = ["/health", "/healthz", "/ready", "/readyz", "/livez", "/api/health", "/status"];
const DB_URL_NAMES = ["DATABASE_URL", "POSTGRES_URL", "PG_URL", "DB_URL", "POSTGRESQL_URL"];
const NPM_PLACEHOLDER_TEST = /no test specified/;

async function firstExisting(source: Source, dir: string, candidates: string[]): Promise<string | null> {
  for (const c of candidates) if ((await source.readFile(projectPath(dir, c))) !== null) return c;
  return null;
}

function runScript(pm: NonNullable<NodeFacts["packageManager"]>, name: string): string[] {
  return pm === "npm" ? ["npm", "run", "--silent", name] : pm === "pnpm" ? ["pnpm", "run", name] : ["yarn", "run", name];
}

/**
 * Read `schema` and `dialect` from a Drizzle config by inspection (it is never executed).
 * Only a single string path to an existing file is used; arrays, globs, directories, and
 * computed values are reported instead of guessed.
 */
export async function drizzleSchema(source: Source, dir: string, configFile: string): Promise<{ schema: string | null; dialect: string | null; why: string }> {
  const text = (await source.readFile(projectPath(dir, configFile))) ?? "";
  const dialect = text.match(/["']?dialect["']?\s*:\s*["']([a-z-]+)["']/)?.[1] ?? null;
  const m = text.match(/["']?schema["']?\s*:\s*(["'])([^"'\n]+)\1\s*[,}\n]/);
  if (!m) return { schema: null, dialect, why: /["']?schema["']?\s*:\s*\[/.test(text) ? "it is an array" : "no string literal found" };
  const raw = m[2]!.trim();
  if (/[*?{}]/.test(raw)) return { schema: null, dialect, why: `"${raw}" is a glob` };
  let rel: string;
  try {
    rel = projectPath(".", raw.replace(/^\.\//, ""));
  } catch {
    return { schema: null, dialect, why: `"${raw}" is not a path inside the project` };
  }
  if ((await source.readFile(projectPath(dir, rel))) === null) return { schema: null, dialect, why: `"${raw}" is not a file (a directory of schema files is not supported)` };
  return { schema: rel, dialect, why: "" };
}

export async function discoverNode(source: Source, dir: string): Promise<Discovery & { node: NodeFacts | null }> {
  const facts: string[] = [];
  const missing: Discovery["missing"] = [];
  /** `key` is the config setting that would resolve this; an override of it drops the message. */
  const need = (area: Area, message: string, key?: string) => missing.push({ area, message, ...(key ? { key } : {}) });
  const layer: Record<string, any> = {};
  const read = (rel: string) => source.readFile(projectPath(dir, rel));

  // ---- package.json and package manager
  let pkg: any = null;
  const pkgText = await read("package.json");
  if (pkgText !== null) {
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      need("config", "package.json is not valid JSON");
    }
  }
  let node: NodeFacts | null = null;
  if (pkg) {
    let lockfile: string | null = null;
    let pm: NodeFacts["packageManager"] = null;
    for (const [f, m] of LOCKFILES) {
      if ((await read(f)) !== null) {
        lockfile = f;
        pm = m;
        break;
      }
    }
    const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
    if (!pm && (declared === "npm" || declared === "pnpm" || declared === "yarn")) pm = declared;
    if ((await read("bun.lockb")) !== null || (await read("bun.lock")) !== null) need("config", "Bun projects are not supported; only npm, pnpm, and Yarn");
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const postgresClient = PG_CLIENTS.find((d) => deps[d]) ?? (deps["@prisma/client"] ? "@prisma/client" : deps["drizzle-orm"] ? "drizzle-orm" : null);
    node = { packageManager: pm ?? "npm", lockfile, scripts, postgresClient };
    const manager = node.packageManager!;
    facts.push(`Node.js project (package.json) using ${manager}${lockfile ? ` with ${lockfile}` : " without a lockfile"}`);
    if (!lockfile) need("config", "no lockfile: dependency versions may differ between the baseline and the candidate install");

    const app: Record<string, any> = {};
    if (Object.keys(deps).length) {
      app.install =
        manager === "npm"
          ? lockfile ? ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"] : ["npm", "install", "--no-audit", "--no-fund", "--no-package-lock"]
          : manager === "pnpm"
            ? ["pnpm", "install", "--frozen-lockfile"]
            : (await read(".yarnrc.yml")) !== null ? ["yarn", "install", "--immutable"] : ["yarn", "install", "--frozen-lockfile"];
    }
    if (scripts.build) {
      app.build = runScript(manager, "build");
      facts.push(`build script: ${scripts.build}`);
    }
    if (scripts.start) {
      app.start = runScript(manager, "start");
      facts.push(`start script: ${scripts.start}`);
    } else {
      need("config", 'no "start" script in package.json; set app.start so Crashpad can run startup, runtime API, permission, and workflow checks', "app.start");
    }
    const tests: string[][] = [];
    const typecheck = ["typecheck", "type-check", "check-types", "tsc"].find((s) => scripts[s]);
    if (typecheck) {
      tests.push(runScript(manager, typecheck));
      facts.push(`typecheck script: ${typecheck}`);
    }
    if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test)) {
      tests.push(runScript(manager, "test"));
      facts.push(`test script: ${scripts.test}`);
    }
    if (tests.length) layer.tests = tests;
    if (Object.keys(app).length) layer.app = app;
    if (postgresClient) facts.push(`PostgreSQL client dependency: ${postgresClient}`);
  } else {
    need("config", "no package.json: only Node.js projects are supported for automatic startup discovery", "app.start");
  }

  // ---- Database: migrations, schema, seed
  const database: Record<string, any> = {};
  const prismaSchema = await read("prisma/schema.prisma");
  const prismaDirs = (await source.listDirs(projectPath(dir, "prisma/migrations"))) ?? [];
  if (prismaSchema !== null && prismaDirs.length) {
    const provider = prismaSchema.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/s)?.[1];
    if (provider === "postgresql" || provider === "postgres") {
      database.migrations = "prisma/migrations";
      database.migrationFormat = "prisma";
      facts.push(`Prisma migrations (prisma/migrations, ${prismaDirs.length} migration(s), provider ${provider})`);
    } else {
      need("database", `Prisma datasource provider is ${provider ?? "unknown"}; only PostgreSQL is supported`);
    }
  }
  if (!database.migrations) {
    const journal = await read("drizzle/meta/_journal.json");
    if (journal !== null) {
      let dialect: string | undefined;
      try {
        dialect = JSON.parse(journal).dialect;
      } catch {
        /* ignore */
      }
      if (dialect && !/^postgres/.test(dialect)) need("database", `Drizzle migrations use dialect ${dialect}; only PostgreSQL is supported`);
      else {
        database.migrations = "drizzle";
        facts.push("Drizzle SQL migrations (drizzle/, ordered by filename)");
      }
    }
  }
  if (!database.migrations) {
    for (const d of SQL_MIGRATION_DIRS) {
      const files = ((await source.listFiles(projectPath(dir, d))) ?? []).filter((f) => f.endsWith(".sql"));
      if (!files.length) continue;
      const first = (await read(`${d}/${files[0]}`)) ?? "";
      if (/^--\s*migrate:down/m.test(first)) {
        need("database", `${d} uses dbmate-style files with "-- migrate:down" sections; running them as plain SQL would also run the down migration, so they are not supported`);
        break;
      }
      if (files.some((f) => /\.(down|undo)\.sql$/.test(f))) {
        need("database", `${d} mixes up and down migration files (*.down.sql); only up-only SQL directories are supported`);
        break;
      }
      database.migrations = d;
      facts.push(`plain SQL migrations (${d}, ${files.length} file(s))`);
      break;
    }
  }
  if (!database.migrations) {
    for (const d of SQL_MIGRATION_DIRS) {
      const files = (await source.listFiles(projectPath(dir, d))) ?? [];
      if (files.some((f) => /\.(js|ts|cjs|mjs)$/.test(f))) {
        need("database", `${d} contains JavaScript/TypeScript migrations (Knex, node-pg-migrate, TypeORM, …), which Crashpad cannot execute; database checks need SQL migrations`);
        break;
      }
    }
  }
  if (!database.migrations && !missing.some((m) => m.area === "database")) {
    const drizzleConfig = await firstExisting(source, dir, ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.json"]);
    if (drizzleConfig) {
      const d = await drizzleSchema(source, dir, drizzleConfig);
      const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, string>;
      if (d.dialect && !/^postgres/.test(d.dialect)) need("database", `${drizzleConfig} uses dialect ${d.dialect}; only PostgreSQL is supported`);
      else if (!d.schema) need("database", `${drizzleConfig} is present and there are no generated migrations, but its schema setting is not a single file path Crashpad can read (${d.why}); set orm.schema to the schema module for schema compatibility testing`, "orm.schema");
      else if (!deps["drizzle-kit"]) need("database", `${drizzleConfig} names the schema ${d.schema}, but drizzle-kit is not a dependency, so the schema cannot be exported; add it as a devDependency for schema compatibility testing`, "orm.schema");
      else {
        layer.orm = { kind: "drizzle", schema: d.schema };
        facts.push(`Drizzle ORM schema: ${d.schema} (from ${drizzleConfig}). There are no committed migrations, so the database area tests SCHEMA COMPATIBILITY between the two versions' schema definitions, not a migration sequence`);
      }
    } else if (prismaSchema !== null && !prismaDirs.length) {
      need("database", "prisma/schema.prisma is present but there is no prisma/migrations directory (a `prisma db push` workflow has no migration history to check); set database.migrations if migrations live elsewhere", "database.migrations");
    } else if (node?.postgresClient) {
      need("database", `a PostgreSQL client (${node.postgresClient}) is a dependency, but no SQL migrations were found in ${SQL_MIGRATION_DIRS.join(", ")}; set database.migrations to enable database checks`, "database.migrations");
    }
  }
  if (database.migrations) {
    const schema = await firstExisting(source, dir, SCHEMA_FILES);
    if (schema) {
      need("database", `found ${schema} but did not use it as the bootstrap schema: it may already contain the migrations. Migrations are applied to an empty database; set database.schema if they start from this file`, "database.schema");
    }
    const seed = await firstExisting(source, dir, SEED_FILES);
    if (seed) {
      database.seed = seed;
      facts.push(`SQL seed data: ${seed}`);
    } else {
      need("database", "no SQL seed file: checks run against tables containing only what migrations insert", "database.seed");
    }
    if ((await read("crashpad.checks.json")) !== null) {
      database.checks = "crashpad.checks.json";
      facts.push("database check manifest: crashpad.checks.json");
    } else {
      need("database", "no read/write/assertion checks (crashpad.checks.json); representative queries and integrity rules cannot be discovered", "database.checks");
    }
    if (node && !node.postgresClient && database.migrationFormat !== "prisma") facts.push("no PostgreSQL client dependency found; assuming the SQL migrations target PostgreSQL");
    layer.database = database;
  }

  // ---- API contract
  const spec = await firstExisting(source, dir, SPEC_FILES);
  let specDoc: any = null;
  if (spec) {
    layer.api = { openapi: spec };
    facts.push(`OpenAPI document: ${spec}`);
    try {
      const t = (await read(spec))!;
      specDoc = spec.endsWith(".json") ? JSON.parse(t) : parseYaml(t);
    } catch {
      specDoc = null;
    }
  } else if ((await firstExisting(source, dir, ["swagger.yaml", "swagger.json"])) !== null) {
    need("api", "found a Swagger 2 document; only OpenAPI 3.0/3.1 contracts are compared");
  } else {
    need("api", "no OpenAPI document found (looked for openapi.{yaml,yml,json} in the project root, openapi/, api/, docs/, spec/)", "api.openapi");
  }

  // ---- Environment contract
  const dotenv = await firstExisting(source, dir, ENV_DOTENV);
  const jsonEnv = dotenv ? null : await firstExisting(source, dir, ENV_JSON);
  let envKeys: string[] = [];
  let documentedKeys: string[] = [];
  if (dotenv) {
    const text = (await read(dotenv)) ?? "";
    envKeys = parseDotenvExample(text).map((d) => d.name);
    documentedKeys = parseDotenvExample(text, { commented: true }).map((d) => d.name);
    facts.push(`environment declared in ${dotenv} (${envKeys.length} variable(s); a dotenv example does not mark variables required, so startup decides)`);
  } else if (jsonEnv) {
    facts.push(`environment schema: ${jsonEnv} (JSON Schema)`);
    try {
      envKeys = Object.keys(JSON.parse((await read(jsonEnv)) ?? "{}").properties ?? {});
    } catch {
      /* reported when loaded */
    }
  } else {
    need("config", "no environment schema (.env.example or env.schema.json); required variables cannot be validated", "app.envSchema");
  }
  if (pkg) {
    layer.app ??= {};
    if (dotenv) layer.app.envSchema = { path: dotenv, format: "dotenv-example" };
    else if (jsonEnv) layer.app.envSchema = { path: jsonEnv, format: "json-schema" };
    const dbVar = DB_URL_NAMES.find((n) => envKeys.includes(n));
    if (dbVar && dbVar !== "DATABASE_URL") layer.app.databaseUrlEnv = dbVar;
    if ((database.migrations || layer.orm) && !dbVar) need("config", "the environment schema does not name the database URL variable; Crashpad sets DATABASE_URL", "app.databaseUrlEnv");
    const health = specDoc ? HEALTH_PATHS.find((p) => specDoc?.paths?.[p]?.get) : undefined;
    if (health) {
      layer.app.readiness = { path: health };
      facts.push(`readiness: GET ${health} (from the OpenAPI document)`);
    } else {
      need("config", specDoc ? "the OpenAPI document declares no health endpoint; readiness means the port accepts connections" : "no health endpoint is known (there is no OpenAPI document); readiness means the port accepts connections", "app.readiness.path");
    }
    // The port variable: PORT, or the one *_PORT variable the env example declares (commented defaults count).
    const ports = [...new Set(documentedKeys.filter((k) => k === "PORT" || /_PORT$/.test(k)))];
    const appPorts = ports.filter((k) => !/^(DB|PG|POSTGRES|POSTGRESQL|DATABASE|REDIS|MYSQL|MONGO|SMTP|MAIL|EMAIL)_/.test(k));
    const nextStart = typeof pkg.scripts?.start === "string" && /^next start(\s|$)/.test(pkg.scripts.start) && !/\s(-p|--port)\b/.test(pkg.scripts.start);
    if (appPorts.includes("PORT")) facts.push("port variable: PORT (declared in the environment example)");
    else if (!appPorts.length && nextStart) facts.push("port variable: PORT (`next start` reads it)");
    else if (appPorts.length === 1) {
      layer.app.portEnv = appPorts[0];
      facts.push(`port variable: ${appPorts[0]} (declared in ${dotenv})`);
    } else if (appPorts.length > 1) {
      need("config", `several port variables are declared (${appPorts.join(", ")}); set app.portEnv to the one the server listens on`, "app.portEnv");
    } else if (layer.app.start) {
      need("config", "no port variable is declared in the environment example; Crashpad assumes the server reads PORT (set app.portEnv if it does not)", "app.portEnv");
    }
  }

  // ---- Runtime checks
  if ((await read("crashpad.http.json")) !== null) {
    layer.http = { checks: "crashpad.http.json" };
    facts.push("runtime check manifest: crashpad.http.json");
  } else {
    need("permissions", "no permission scenarios (crashpad.http.json): access expectations must be stated explicitly and are never inferred", "http.checks");
    need("workflows", "no workflow scenarios (crashpad.http.json)", "http.checks");
  }
  return { layer, facts, missing, node };
}
