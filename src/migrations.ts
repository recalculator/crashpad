import type { LoadedProject } from "./config.ts";
import type { HistoryIssue } from "./report/types.ts";
import type { Source } from "./source.ts";

export interface MigrationFile {
  name: string;
  path: string;
  sql: string;
}

export interface MigrationPlan {
  /** Migrations present at the baseline, applied to both databases (in order). */
  baseline: MigrationFile[];
  /** Migrations added by the candidate, applied only to the candidate database (in order). */
  added: MigrationFile[];
  history: HistoryIssue[];
}

/** Migration ordering is plain byte-wise filename order, e.g. `001_init.sql` < `002_x.sql`. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ordered migrations of a project.
 * - `sql-dir`: `<dir>/*.sql`, byte-wise filename order.
 * - `prisma`: `<dir>/<name>/migration.sql`, byte-wise directory-name order (Prisma's
 *   timestamped names sort chronologically). The migration's name is its directory.
 */
export async function listMigrations(source: Source, project: Pick<LoadedProject, "paths" | "migrationFormat">): Promise<MigrationFile[]> {
  const dir = project.paths.migrations;
  const out: MigrationFile[] = [];
  if (project.migrationFormat === "prisma") {
    for (const name of ((await source.listDirs(dir)) ?? []).sort(compareNames)) {
      const path = `${dir}/${name}/migration.sql`;
      const sql = await source.readFile(path);
      if (sql !== null) out.push({ name, path, sql });
    }
    return out;
  }
  const names = (await source.listFiles(dir)) ?? [];
  for (const name of names.filter((n) => n.endsWith(".sql")).sort(compareNames)) {
    const path = `${dir}/${name}`;
    const sql = await source.readFile(path);
    if (sql !== null) out.push({ name, path, sql });
  }
  return out;
}

/**
 * Compare migration history between baseline and candidate. The candidate database
 * is always "baseline database + newly added migration files"; rewritten or removed
 * history is reported explicitly instead of guessed at.
 */
export async function planMigrations(
  baseProject: LoadedProject,
  baseSource: Source,
  candProject: LoadedProject,
  candSource: Source,
): Promise<MigrationPlan> {
  const baseline = await listMigrations(baseSource, baseProject);
  const candidate = await listMigrations(candSource, candProject);
  const baseByName = new Map(baseline.map((m) => [m.name, m]));
  const candByName = new Map(candidate.map((m) => [m.name, m]));
  const history: HistoryIssue[] = [];
  for (const m of baseline) {
    const c = candByName.get(m.name);
    if (!c) {
      history.push({
        kind: "removed-migration",
        file: m.path,
        message: `Migration ${m.name} exists at the baseline but was removed. Databases that already applied it keep its effects; Crashpad keeps it applied.`,
        blocking: true,
      });
    } else if (c.sql !== m.sql) {
      history.push({
        kind: "edited-migration",
        file: c.path,
        message: `Migration ${m.name} was edited after it existed at the baseline. Databases that already applied the original will not re-run it, so the edit is NOT applied. Add a new migration instead.`,
        blocking: true,
      });
    }
  }
  const lastBaseline = baseline.at(-1)?.name;
  const added = candidate.filter((m) => !baseByName.has(m.name));
  for (const m of added) {
    if (lastBaseline && compareNames(m.name, lastBaseline) < 0) {
      history.push({
        kind: "out-of-order-migration",
        file: m.path,
        message: `New migration ${m.name} sorts before existing migration ${lastBaseline}. Deployed databases would apply it out of order; Crashpad applies it after the baseline migrations.`,
        blocking: true,
      });
    }
  }
  return { baseline, added, history };
}
