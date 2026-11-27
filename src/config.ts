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
    /** Per-file deadline for schema, seed, and migration scripts. */
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

export interface LoadedProject {
  projectDir: string;
  configPath: string;
  config: Config;
  manifestPath: string;
  manifest: Manifest;
  /** Repo-relative resolved paths. */
  paths: { schema: string; seed?: string; migrations: string; checks: string };
}

/** Load and validate config + manifest from a source. Returns null if no config file exists. */
export async function loadProject(source: Source, projectDir: string): Promise<LoadedProject | null> {
  let configPath: string;
  try {
    configPath = projectPath(projectDir, CONFIG_FILE, "config path");
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const raw = await source.readFile(configPath);
  if (raw === null) return null;
  const parsed = ConfigSchema.safeParse(parseJson(raw, configPath));
  if (!parsed.success) throw new ConfigError(`${configPath}: ${formatZod(parsed.error)}`);
  const config = parsed.data;
  const resolve = (p: string, what: string): string => {
    try {
      return projectPath(projectDir, p, what);
    } catch (err) {
      if (err instanceof PathError) throw new ConfigError(`${configPath}: ${err.message}`);
      throw err;
    }
  };
  const paths = {
    schema: resolve(config.schema, "schema"),
    ...(config.seed ? { seed: resolve(config.seed, "seed") } : {}),
    migrations: resolve(config.migrations, "migrations"),
    checks: resolve(config.checks, "checks"),
  };
  const manifestRaw = await source.readFile(paths.checks);
  if (manifestRaw === null) throw new ConfigError(`${configPath}: check manifest not found: ${paths.checks}`);
  const m = ManifestSchema.safeParse(parseJson(manifestRaw, paths.checks));
  if (!m.success) throw new ConfigError(`${paths.checks}: ${formatZod(m.error)}`);
  for (const c of m.data.checks) {
    if (c.source) {
      try {
        projectPath(projectDir, c.source, `checks[${c.id}].source`);
      } catch (err) {
        throw new ConfigError(`${paths.checks}: ${(err as Error).message}`);
      }
    }
  }
  return { projectDir, configPath, config, manifestPath: paths.checks, manifest: m.data, paths };
}

export function checkSourcePath(project: LoadedProject, check: CheckDef): string | null {
  return check.source ? projectPath(project.projectDir, check.source) : null;
}
