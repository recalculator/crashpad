import { z } from "zod";
import { normalizeRepoPath, PathError, projectPath } from "./paths.ts";
import type { Source } from "./source.ts";

export const CONFIG_FILE = "crashpad.config.json";

const relPath = z.string().min(1).refine((p) => {
  try {
    normalizeRepoPath(p);
    return !normalizeRepoPath(p).startsWith("..");
  } catch {
    return false;
  }
}, "must be a relative path inside the project (no absolute paths, '..', or backslashes)");

export const LimitsSchema = z
  .object({
    /** Max rows compared per query side. Larger results make the check inconclusive. */
    maxRows: z.number().int().positive().max(1_000_000).default(1000),
    /** Per-statement deadline for checks. */
    statementTimeoutMs: z.number().int().positive().max(600_000).default(5000),
    /** Per-statement deadline for schema, seed, and migration scripts. */
    migrationTimeoutMs: z.number().int().positive().max(3_600_000).default(60_000),
    /** Deadline for the whole run. Checks not started before it are reported as not run. */
    totalTimeoutMs: z.number().int().positive().max(7_200_000).default(300_000),
  })
  .strict();

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    /** Bootstrap schema SQL: the database state before the first file in `migrations`. */
    schema: relPath,
    /** Optional synthetic sample data, loaded right after `schema` and before any migrations. */
    seed: relPath.optional(),
    /** Directory of `.sql` migration files applied in lexicographic filename order. */
    migrations: relPath,
    /** Check manifest JSON file. */
    checks: relPath,
    limits: LimitsSchema.default({ maxRows: 1000, statementTimeoutMs: 5000, migrationTimeoutMs: 60_000, totalTimeoutMs: 300_000 }),
    report: z
      .object({
        /** Number of differing example rows included per changed-result finding. 0 disables samples. */
        rowSamples: z.number().int().min(0).max(20).default(0),
      })
      .strict()
      .default({ rowSamples: 0 }),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type Limits = z.infer<typeof LimitsSchema>;

const ParamValue: z.ZodType<unknown> = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any()), z.record(z.string(), z.any())]);

export const CheckSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, "check ids are lowercase letters, digits, '.', '_' or '-' (max 100 chars)"),
    category: z.enum(["read", "write", "assertion"]),
    description: z.string().optional(),
    source: relPath.optional(),
    sql: z.string().min(1).optional(),
    params: z.array(ParamValue).default([]),
    /** Read checks: compare rows in order instead of as a multiset. */
    ordered: z.boolean().default(false),
    /** Write checks: the expected affected-row count. */
    expectRows: z.number().int().min(0).optional(),
    /** Write checks: compare RETURNING output between baseline and candidate. */
    compareReturning: z.boolean().default(true),
    /** Output columns excluded from result comparison (e.g. generated ids, timestamps). */
    ignoreColumns: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!!c.source === !!c.sql) ctx.addIssue({ code: "custom", message: "exactly one of 'source' or 'sql' is required" });
    if (c.category !== "read" && c.ordered) ctx.addIssue({ code: "custom", message: "'ordered' only applies to read checks" });
    if (c.category !== "write" && c.expectRows !== undefined)
      ctx.addIssue({ code: "custom", message: "'expectRows' only applies to write checks" });
  });

export const ManifestSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    checks: z.array(CheckSchema),
    /** Checks intentionally removed. Removal of an unlisted check is flagged for review. */
    retired: z.array(z.object({ id: z.string(), reason: z.string().min(1) }).strict()).default([]),
  })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const c of m.checks) {
      if (seen.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate check id: ${c.id}` });
      seen.add(c.id);
    }
  });

export type CheckDef = z.infer<typeof CheckSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

function formatZod(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file}: invalid JSON: ${(err as Error).message}`);
  }
}

export const MigrationFormat = z.enum(["sql-dir", "prisma"]);
export type MigrationFormat = z.infer<typeof MigrationFormat>;

const DEFAULT_LIMITS = { maxRows: 1000, statementTimeoutMs: 5000, migrationTimeoutMs: 60_000, totalTimeoutMs: 300_000 };

/**
 * The `database` section of a version-2 config (or of a discovered configuration).
 * Unlike version 1, the bootstrap schema and the check manifest are optional: a
 * project whose migrations build the whole schema from an empty database needs
 * neither, and migration execution and history checks still run without checks.
 */
export const DatabaseConfigSchema = z
  .object({
    schema: relPath.optional(),
    seed: relPath.optional(),
    /**
     * When the seed loads: `bootstrap` (right after `schema`, so migrations transform it)
     * or `after-baseline-migrations` (written against the current schema). Defaults to
     * `bootstrap` with a schema file and `after-baseline-migrations` without one.
     */
    seedAt: z.enum(["bootstrap", "after-baseline-migrations"]).optional(),
    migrations: relPath,
    /** `sql-dir`: `*.sql` files in filename order. `prisma`: `<dir>/<name>/migration.sql` in directory order. */
    migrationFormat: MigrationFormat.default("sql-dir"),
    checks: relPath.optional(),
    limits: LimitsSchema.default(DEFAULT_LIMITS),
    report: z.object({ rowSamples: z.number().int().min(0).max(20).default(0) }).strict().default({ rowSamples: 0 }),
  })
  .strict();
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export interface LoadedProject {
  projectDir: string;
  /** Where the configuration came from: a repo-relative file, or a label such as `(discovered)`. */
  configPath: string;
  config: { limits: Limits; report: { rowSamples: number } };
  manifestPath: string;
  manifest: Manifest;
  migrationFormat: MigrationFormat;
  seedAt: "bootstrap" | "after-baseline-migrations";
  /** Repo-relative resolved paths. */
  paths: { schema?: string; seed?: string; migrations: string; checks?: string };
}

export function formatConfigError(err: z.ZodError): string {
  return formatZod(err);
}

/** Build a database project from a database config section, reading the manifest from `source`. */
export async function projectFromDatabaseConfig(source: Source, projectDir: string, db: DatabaseConfig, configPath: string): Promise<LoadedProject> {
  const resolve = (p: string, what: string): string => {
    try {
      return projectPath(projectDir, p, what);
    } catch (err) {
      if (err instanceof PathError) throw new ConfigError(`${configPath}: ${err.message}`);
      throw err;
    }
  };
  const paths: LoadedProject["paths"] = {
    ...(db.schema ? { schema: resolve(db.schema, "schema") } : {}),
    ...(db.seed ? { seed: resolve(db.seed, "seed") } : {}),
    migrations: resolve(db.migrations, "migrations"),
    ...(db.checks ? { checks: resolve(db.checks, "checks") } : {}),
  };
  let manifest: Manifest = { version: 1, checks: [], retired: [] };
  let manifestPath = configPath;
  if (paths.checks) {
    const manifestRaw = await source.readFile(paths.checks);
    if (manifestRaw === null) throw new ConfigError(`${configPath}: check manifest not found: ${paths.checks}`);
    const m = ManifestSchema.safeParse(parseJson(manifestRaw, paths.checks));
    if (!m.success) throw new ConfigError(`${paths.checks}: ${formatZod(m.error)}`);
    manifest = m.data;
    manifestPath = paths.checks;
    for (const c of manifest.checks) {
      if (c.source) {
        try {
          projectPath(projectDir, c.source, `checks[${c.id}].source`);
        } catch (err) {
          throw new ConfigError(`${paths.checks}: ${(err as Error).message}`);
        }
      }
    }
  }
  const seedAt = db.seedAt ?? (paths.schema ? "bootstrap" : "after-baseline-migrations");
  return { projectDir, configPath, config: { limits: db.limits, report: db.report }, manifestPath, manifest, migrationFormat: db.migrationFormat, seedAt, paths };
}

/**
 * Load the database project from `crashpad.config.json`. Version 1 files describe
 * only the database; version 2 files carry it under `database`. Returns null if no
 * config file exists, or if a version-2 file has no database section.
 */
export async function loadProject(source: Source, projectDir: string): Promise<LoadedProject | null> {
  let configPath: string;
  try {
    configPath = projectPath(projectDir, CONFIG_FILE, "config path");
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const raw = await source.readFile(configPath);
  if (raw === null) return null;
  const json = parseJson(raw, configPath) as { version?: unknown; database?: unknown };
  if (json && typeof json === "object" && json.version === 2) {
    if (json.database === undefined) return null;
    const d = DatabaseConfigSchema.safeParse(json.database);
    if (!d.success) throw new ConfigError(`${configPath}: database: ${formatZod(d.error)}`);
    return projectFromDatabaseConfig(source, projectDir, d.data, configPath);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) throw new ConfigError(`${configPath}: ${formatZod(parsed.error)}`);
  const c = parsed.data;
  return projectFromDatabaseConfig(
    source,
    projectDir,
    { schema: c.schema, ...(c.seed ? { seed: c.seed } : {}), migrations: c.migrations, migrationFormat: "sql-dir", checks: c.checks, limits: c.limits, report: c.report },
    configPath,
  );
}

export function checkSourcePath(project: LoadedProject, check: CheckDef): string | null {
  return check.source ? projectPath(project.projectDir, check.source) : null;
}
