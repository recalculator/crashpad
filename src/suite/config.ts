import { z } from "zod";
import { CONFIG_FILE, ConfigError, ConfigSchema, DatabaseConfigSchema, formatConfigError, parseJson } from "../config.ts";
import { normalizeRepoPath, projectPath } from "../paths.ts";
import type { Source } from "../source.ts";

const relPath = z.string().min(1).refine((p) => {
  try {
    return !normalizeRepoPath(p).startsWith("..");
  } catch {
    return false;
  }
}, "must be a relative path inside the project (no absolute paths, '..', or backslashes)");

const argv = z.array(z.string().min(1)).min(1);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

export const ApiConfigSchema = z
  .object({
    /** OpenAPI 3.x document (YAML or JSON). Compared statically between baseline and candidate. */
    openapi: relPath.optional(),
    /**
     * Spec-derived runtime smoke checks: GET operations with no required parameters and
     * no security requirement are called on both versions and compared. Needs `app`.
     */
    smoke: z.boolean().default(true),
  })
  .strict();

export const EnvSchemaRef = z
  .object({
    path: relPath,
    /** `dotenv-example`: declares variables (never treated as required; startup decides). `json-schema`: a JSON Schema whose `required` list is enforced. */
    format: z.enum(["dotenv-example", "json-schema"]),
  })
  .strict();

export const AppConfigSchema = z
  .object({
    /** App directory relative to the project. Commands run here. */
    root: relPath.default("."),
    /** Dependency install command (argv, no shell), run once per version. `null` skips installing. */
    install: argv.nullable().default(null),
    /** Build command run after install (argv, no shell), e.g. a TypeScript compile. */
    build: argv.nullable().default(null),
    /** Command that starts the HTTP server (argv, no shell). Runtime checks need it. */
    start: argv.optional(),
    /** Test-only environment values. Never production values. */
    env: z.record(envName, z.string()).default({}),
    envSchema: EnvSchemaRef.optional(),
    /** Use non-empty values from a dotenv-example env schema as test values. */
    useExampleValues: z.boolean().default(true),
    portEnv: envName.default("PORT"),
    /** Set to the throwaway database's URL when the project has a database. */
    databaseUrlEnv: envName.default("DATABASE_URL"),
    readiness: z
      .object({
        /** HTTP path polled until it answers 2xx. Without it, readiness means the port accepts connections. */
        path: z.string().startsWith("/").optional(),
        timeoutMs: z.number().int().positive().max(600_000).default(30_000),
      })
      .strict()
      .default({ timeoutMs: 30_000 }),
    installTimeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
    requestTimeoutMs: z.number().int().positive().max(600_000).default(10_000),
    scenarioTimeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
  })
  .strict();

export const SuiteConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(2),
    database: DatabaseConfigSchema.optional(),
    api: ApiConfigSchema.optional(),
    app: AppConfigSchema.optional(),
    /** Runtime checks: API behavior, permissions, and workflows (see crashpad.http.json). */
    http: z.object({ checks: relPath }).strict().optional(),
    /**
     * The project's own test and typecheck commands (argv, no shell). They run on both
     * versions and are reported separately from Crashpad's checks; repair verification
     * requires the ones that passed at the baseline to pass.
     */
    tests: z.array(argv).optional(),
    /**
     * A schema defined in ORM code instead of SQL migrations. Used by the database area for
     * schema compatibility testing when there are no committed migrations (`database`).
     */
    orm: z
      .object({
        kind: z.literal("drizzle"),
        /** The Drizzle schema module (a single file), relative to the project. */
        schema: relPath,
        exportTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SuiteConfig = z.infer<typeof SuiteConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

/** An unparsed, possibly partial configuration layer (discovered, stored settings, or a repo file). */
export type ConfigLayer = { [K in keyof SuiteConfig]?: unknown };

export interface EffectiveConfig {
  config: SuiteConfig;
  /** Human-readable origin of each layer, lowest precedence first. */
  sources: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Section-level deep merge of raw layers: later layers override earlier ones; arrays are replaced. */
export function mergeLayers(...layers: ConfigLayer[]): Record<string, unknown> {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a;
    if (isPlainObject(a) && isPlainObject(b)) {
      const out: Record<string, unknown> = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
      return out;
    }
    return b;
  };
  let acc: Record<string, unknown> = {};
  for (const l of layers) acc = merge(acc, l) as Record<string, unknown>;
  return acc;
}

/** Read `crashpad.config.json` (version 1 or 2) as a raw layer, or null if absent. */
export async function readConfigFileLayer(source: Source, projectDir: string): Promise<{ layer: ConfigLayer; path: string } | null> {
  const p = projectPath(projectDir, CONFIG_FILE, "config path");
  const raw = await source.readFile(p);
  if (raw === null) return null;
  const json = parseJson(raw, p);
  if (isPlainObject(json) && json.version === 2) {
    const { $schema: _s, version: _v, ...rest } = json;
    return { layer: rest as ConfigLayer, path: p };
  }
  // Version 1: a database-only file.
  const v1 = ConfigSchema.safeParse(json);
  if (!v1.success) throw new ConfigError(`${p}: ${formatConfigError(v1.error)}`);
  const c = v1.data;
  return {
    layer: { database: { schema: c.schema, ...(c.seed ? { seed: c.seed } : {}), migrations: c.migrations, checks: c.checks, limits: c.limits, report: c.report } },
    path: p,
  };
}

export function parseEffective(raw: Record<string, unknown>, label: string): SuiteConfig {
  const parsed = SuiteConfigSchema.safeParse({ version: 2, ...raw });
  if (!parsed.success) throw new ConfigError(`${label}: ${formatConfigError(parsed.error)}`);
  return parsed.data;
}
