import { ACTIONABLE, REPORT_SCHEMA, UNDECIDED, type CheckFinding, type Classification, type HistoryIssue, type MigrationEntry, type Problem, type Report, type ReportedError, type SideOutcome, type SourceLocation } from "./report/types.ts";
import { ConfigError, loadProject, type Limits, type LoadedProject } from "./config.ts";
import { loadFixtures, type Fixture } from "./fixtures.ts";
import { planMigrations, type MigrationPlan } from "./migrations.ts";
import { compareColumns, compareRows, dropIgnored } from "./compare.ts";
import { PgServer, type Catalog, type DbError, type Outcome, type PgSession, type QueryResult } from "./db/postgres.ts";
import { ensureParser, lineCol } from "./sql/parser.ts";
import type { Source } from "./source.ts";
import { PathError } from "./paths.ts";
import { VERSION } from "./version.ts";

export interface RunInput {
  projectDir: string;
  base: { ref: string; commit: string; source: Source };
  candidate: { label: string; commit: string | null; source: Source };
  server: PgServer;
  keepDatabases?: boolean;
  log?: (msg: string) => void;
}

export interface RunResult {
  report: Report;
  /** Columns of the baseline database, used by the fixer for scope resolution. */
  baselineCatalog: Catalog | null;
  baseProject: LoadedProject | null;
  candProject: LoadedProject | null;
  candFixtures: Map<string, Fixture>;
  migrations: MigrationPlan | null;
}

const PG_ERROR_NAMES: Record<string, string> = {
  "42703": "undefined_column",
  "42P01": "undefined_table",
  "42883": "undefined_function",
  "42601": "syntax_error",
  "42804": "datatype_mismatch",
  "23502": "not_null_violation",
  "23503": "foreign_key_violation",
  "23505": "unique_violation",
  "23514": "check_violation",
  "22P02": "invalid_text_representation",
  "22003": "numeric_value_out_of_range",
  "57014": "query_canceled",
  "25006": "read_only_sql_transaction",
  "08P01": "protocol_violation",
};

export function pgErrorName(code: string | null): string {
  return code ? (PG_ERROR_NAMES[code] ?? code) : "error";
}

function emptySummary(): Report["summary"] {
  return {
    total: 0,
    pass: 0,
    regression: 0,
    "changed-result": 0,
    "failed-assertion": 0,
    "baseline-failure": 0,
    "invalid-fixture": 0,
    inconclusive: 0,
    skipped: 0,
    removed: 0,
    retired: 0,
  };
}

function reportError(err: DbError, fixture: Fixture | null): ReportedError {
  const out: ReportedError = { code: err.code, message: err.message };
  if (fixture && err.position !== undefined) {
    const { line, column } = lineCol(fixture.sql, err.position - 1);
    out.at = { path: fixture.origin.path, line, column };
  }
  return out;
}

function scriptError(err: DbError, path: string, sql: string): ReportedError {
  const out: ReportedError = { code: err.code, message: err.message };
  if (err.position !== undefined) {
    const { line, column } = lineCol(sql, err.position - 1);
    out.at = { path, line, column };
  }
  return out;
}

function location(f: Fixture | undefined): SourceLocation | null {
  return f ? { kind: f.origin.kind, path: f.origin.path, line: f.origin.line } : null;
}

interface SideRun {
  outcome: SideOutcome;
  result?: QueryResult;
  error?: DbError;
}

async function runSide(session: PgSession, f: Fixture, limits: Limits, deadline: number): Promise<SideRun> {
  if (f.invalid) return { outcome: { status: "invalid", invalidReason: f.invalid } };
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { outcome: { status: "not-run" } };
  const started = Date.now();
  const res: Outcome<QueryResult> = await session.execute(f.sql, f.def.params, {
    readOnly: f.def.category !== "write",
    maxRows: limits.maxRows,
    timeoutMs: Math.min(limits.statementTimeoutMs, remaining),
  });
  const durationMs = Date.now() - started;
  if (!res.ok) return { outcome: { status: "error", error: reportError(res.error, f), durationMs }, error: res.error };
  const r = res.value;
  const outcome: SideOutcome = { status: "ok", columns: r.columns, rowCount: r.rows.length, truncated: r.truncated, durationMs };
  if (f.def.category === "write") outcome.affectedRows = r.rowCount;
  if (f.def.category === "assertion") outcome.assertion = assertionValue(r).value;
  return { outcome, result: r };
}

/** An assertion must return exactly one row with one boolean column that is not NULL. */
export function assertionValue(r: QueryResult): { value: boolean | null; invalid?: string } {
  if (r.columns.length !== 1) return { value: null, invalid: `assertion must return exactly one column (got ${r.columns.length})` };
  if (r.columns[0]!.type !== "boolean") return { value: null, invalid: `assertion must return a boolean (got ${r.columns[0]!.type})` };
  if (r.rows.length !== 1) return { value: null, invalid: `assertion must return exactly one row (got ${r.rows.length}${r.truncated ? "+" : ""})` };
  const v = r.rows[0]![0];
  if (v === null || v === undefined) return { value: null, invalid: "assertion returned NULL; use coalesce() or a NOT EXISTS form" };
  return { value: v === "t" };
}

function errorText(e: DbError): string {
  return `${pgErrorName(e.code)}${e.code ? ` (${e.code})` : ""}: ${e.message}`;
}

/** Decide how one check behaved, given baseline and candidate side runs. */
export function classify(
  base: SideRun | null,
  cand: SideRun,
  f: Fixture,
  sampleLimit: number,
): Pick<CheckFinding, "classification" | "reason" | "message" | "columnDiff" | "rowDiff"> {
  const def = f.def;
  const undecided = (side: "baseline" | "candidate", run: SideRun) => {
    if (run.outcome.status === "invalid") return { classification: "invalid-fixture" as const, reason: "invalid-fixture", message: `${side} fixture is invalid: ${run.outcome.invalidReason}` };
    if (run.outcome.status === "not-run") return { classification: "inconclusive" as const, reason: "deadline", message: `${side} not run: total run deadline reached` };
    if (run.error?.timeout) return { classification: "inconclusive" as const, reason: "timeout", message: `${side} exceeded the statement deadline` };
    if (run.error?.infrastructure) return { classification: "inconclusive" as const, reason: "infrastructure", message: `${side} infrastructure error: ${errorText(run.error)}` };
    if (run.outcome.truncated) return { classification: "inconclusive" as const, reason: "limit-exceeded", message: `${side} returned more than the configured maxRows; results were not compared` };
    return null;
  };

  // --- Baseline must be valid and passing for the check to vouch for anything.
  if (base) {
    const u = undecided("baseline", base);
    if (u) return u;
    if (base.outcome.status === "error") {
      return { classification: "baseline-failure", reason: pgErrorName(base.error!.code), message: `Already failing before this change — ${errorText(base.error!)}` };
    }
    if (def.category === "assertion") {
      const a = assertionValue(base.result!);
      if (a.invalid) return { classification: "invalid-fixture", reason: "invalid-assertion", message: `Invalid assertion fixture: ${a.invalid}` };
      if (a.value === false) return { classification: "baseline-failure", reason: "assertion-false-at-baseline", message: "Assertion was already false before this change" };
    }
    if (def.category === "write" && def.expectRows !== undefined && base.result!.rowCount !== def.expectRows) {
      return { classification: "baseline-failure", reason: "unexpected-row-count-at-baseline", message: `Baseline affected ${base.result!.rowCount} row(s); expected ${def.expectRows}` };
    }
  }

  // --- Candidate.
  if (cand.outcome.status === "invalid") {
    return { classification: "invalid-fixture", reason: "invalid-fixture", message: `Candidate fixture is invalid: ${cand.outcome.invalidReason}` };
  }
  if (cand.outcome.status === "error" && !cand.error!.infrastructure) {
    return {
      classification: "regression",
      reason: pgErrorName(cand.error!.code),
      message: base ? `Worked before, now fails — ${errorText(cand.error!)}` : `New check fails — ${errorText(cand.error!)}`,
    };
  }
  const u = undecided("candidate", cand);
  if (u) return u;
  const c = cand.result!;

  if (def.category === "assertion") {
    const a = assertionValue(c);
    if (a.invalid) return { classification: "invalid-fixture", reason: "invalid-assertion", message: `Invalid assertion fixture: ${a.invalid}` };
    if (a.value === false) {
      return { classification: "failed-assertion", reason: "assertion-false", message: base ? "Assertion held before this change and is now false" : "New assertion is false" };
    }
    return { classification: "pass", reason: "ok", message: base ? "Assertion holds" : "New assertion holds" };
  }

  if (def.category === "write") {
    const expected = def.expectRows ?? base?.result!.rowCount;
    if (expected !== undefined && expected !== null && c.rowCount !== expected) {
      return {
        classification: "changed-result",
        reason: "row-count-changed",
        message: `Affected ${c.rowCount} row(s); expected ${expected}${def.expectRows === undefined ? " (baseline)" : ""}`,
      };
    }
  }

  if (!base) return { classification: "pass", reason: "ok", message: "New check runs successfully (no baseline contract to compare against)" };

  const compareOutput = def.category === "read" || (def.category === "write" && def.compareReturning);
  if (compareOutput) {
    const b = dropIgnored(base.result!, def.ignoreColumns);
    const k = dropIgnored(c, def.ignoreColumns);
    const colDiff = compareColumns(b.columns, k.columns);
    if (colDiff) {
      return { classification: "changed-result", reason: "columns-changed", message: `Output columns changed: ${colDiff.changes.join("; ")}`, columnDiff: colDiff };
    }
    const rowDiff = compareRows(b.rows, k.rows, def.category === "read" && def.ordered, sampleLimit);
    if (rowDiff) {
      const parts = [`${rowDiff.missingCount} baseline row(s) missing`, `${rowDiff.extraCount} unexpected row(s)`];
      if (rowDiff.firstDifferenceAt !== undefined) parts.push(`first ordered difference at row ${rowDiff.firstDifferenceAt + 1}`);
      const { samples, ...rest } = rowDiff;
      return {
        classification: "changed-result",
        reason: "rows-changed",
        message: `Result rows changed: ${parts.join(", ")}`,
        rowDiff: sampleLimit > 0 ? { ...rest, samples } : rest,
      };
    }
  }
  return { classification: "pass", reason: "ok", message: "Same behavior as baseline" };
}

export function exitCodeFor(report: Pick<Report, "problems" | "checks" | "migrations" | "history">): 0 | 1 | 2 {
  if (report.problems.length > 0) return 2;
  if (report.migrations.new.some((m) => m.status === "failed")) return 1;
  if (report.checks.some((c) => ACTIONABLE.has(c.classification))) return 1;
  if (report.checks.some((c) => UNDECIDED.has(c.classification))) return 2;
  if (report.history.some((h) => h.blocking)) return 2;
  return 0;
}

function headline(r: Report): string {
  if (r.problems.length) return `Could not complete: ${r.problems[0]!.message}`;
  const failed = r.migrations.new.find((m) => m.status === "failed");
  if (failed) return `Migration ${failed.file} failed: ${failed.error?.message ?? "error"}`;
  const s = r.summary;
  const bad = s.regression + s["changed-result"] + s["failed-assertion"] + s.removed;
  if (bad) return `${bad} of ${s.total} check(s) broke`;
  const undecided = s["baseline-failure"] + s["invalid-fixture"] + s.inconclusive + s.skipped;
  if (undecided) return `${undecided} check(s) could not be decided`;
  if (r.history.some((h) => h.blocking)) return "Migration history was rewritten";
  return `All ${s.total} check(s) passed`;
}

export async function runChecks(input: RunInput): Promise<RunResult> {
  const started = Date.now();
  const log = input.log ?? (() => {});
  await ensureParser();
  const problems: Problem[] = [];
  const history: HistoryIssue[] = [];
  const checks: CheckFinding[] = [];
  const newMigrations: MigrationEntry[] = [];
  let baselineMigrationNames: string[] = [];
  let serverVersionNum: number | null = null;
  let baselineCatalog: Catalog | null = null;
  let baseProject: LoadedProject | null = null;
  let candProject: LoadedProject | null = null;
  let candFixtures = new Map<string, Fixture>();
  let plan: MigrationPlan | null = null;

  const finish = (): RunResult => {
    const summary = emptySummary();
    for (const c of checks) {
      summary[c.classification]++;
      summary.total++;
    }
    const partial = { problems, checks, migrations: { baseline: baselineMigrationNames, new: newMigrations }, history };
    const exitCode = exitCodeFor(partial);
    const report: Report = {
      schemaVersion: REPORT_SCHEMA,
      tool: { name: "crashpad", version: VERSION },
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      project: input.projectDir,
      base: { ref: input.base.ref, commit: input.base.commit },
      candidate: { label: input.candidate.label, commit: input.candidate.commit },
      database: { serverVersionNum },
      exitCode,
      status: exitCode === 0 ? "pass" : exitCode === 1 ? "fail" : "error",
      headline: "",
      ...partial,
      summary,
    };
    report.headline = headline(report);
    return { report, baselineCatalog, baseProject, candProject, candFixtures, migrations: plan };
  };

  // ---- Configuration
  try {
    baseProject = await loadProject(input.base.source, input.projectDir);
    if (!baseProject) problems.push({ kind: "config", message: `No crashpad.config.json in ${input.projectDir} at baseline ${input.base.ref}; the baseline contract is unknown` });
    candProject = await loadProject(input.candidate.source, input.projectDir);
    if (!candProject) problems.push({ kind: "config", message: `No crashpad.config.json in ${input.projectDir} in ${input.candidate.label}` });
  } catch (err) {
    if (err instanceof ConfigError || err instanceof PathError) {
      problems.push({ kind: "config", message: err.message });
      return finish();
    }
    throw err;
  }
  if (!baseProject || !candProject) return finish();

  const limits = candProject.config.limits;
  const sampleLimit = candProject.config.report.rowSamples;
  const deadline = started + limits.totalTimeoutMs;

  let baseFixtures: Map<string, Fixture>;
  let schemaSql: string | null;
  let seedSql: string | null = null;
  try {
    baseFixtures = await loadFixtures(baseProject, input.base.source);
    candFixtures = await loadFixtures(candProject, input.candidate.source);
    plan = await planMigrations(baseProject, input.base.source, candProject, input.candidate.source);
    history.push(...plan.history);
    schemaSql = await input.base.source.readFile(baseProject.paths.schema);
    if (schemaSql === null) {
      problems.push({ kind: "config", message: `Baseline schema file not found: ${baseProject.paths.schema}` });
      return finish();
    }
    const candSchema = await input.candidate.source.readFile(candProject.paths.schema);
    if (candSchema !== schemaSql) {
      history.push({
        kind: "schema-edited",
        file: candProject.paths.schema,
        message: "The bootstrap schema file differs from the baseline. Schema changes must be expressed as new migrations; Crashpad uses the baseline schema for both databases.",
        blocking: true,
      });
    }
    if (baseProject.paths.seed) {
      seedSql = await input.base.source.readFile(baseProject.paths.seed);
      if (seedSql === null) {
        problems.push({ kind: "config", message: `Baseline seed file not found: ${baseProject.paths.seed}` });
        return finish();
      }
    }
    const candSeed = candProject.paths.seed ? await input.candidate.source.readFile(candProject.paths.seed) : null;
    if (candSeed !== seedSql) {
      history.push({
        kind: "seed-changed",
        file: candProject.paths.seed ?? baseProject.paths.seed ?? "(seed)",
        message: "Sample data differs from the baseline. Checks always run on the baseline sample data, so seed edits cannot hide a regression.",
        blocking: false,
      });
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof PathError) {
      problems.push({ kind: "config", message: err.message });
      return finish();
    }
    throw err;
  }
  baselineMigrationNames = plan.baseline.map((m) => m.path);

  // ---- Databases
  const server = input.server;
  const baseDb = PgServer.uniqueName("base");
  const candDb = PgServer.uniqueName("cand");
  const created: string[] = [];
  let baseSession: PgSession | null = null;
  let candSession: PgSession | null = null;
  try {
    try {
      serverVersionNum = await server.serverVersion();
      await server.createDatabase(baseDb);
      created.push(baseDb);
    } catch (err) {
      problems.push({ kind: "infrastructure", message: `Cannot create database on PostgreSQL server: ${(err as Error).message}` });
      return finish();
    }
    log(`building baseline database ${baseDb}`);
    baseSession = await server.connect(baseDb);
    const scripts: Array<{ path: string; sql: string }> = [
      // Seed data is loaded against the bootstrap schema and then transformed by the
      // migrations, the same way production data is.
      { path: baseProject.paths.schema, sql: schemaSql },
      ...(baseProject.paths.seed && seedSql !== null ? [{ path: baseProject.paths.seed, sql: seedSql }] : []),
      ...plan.baseline.map((m) => ({ path: m.path, sql: m.sql })),
    ];
    for (const s of scripts) {
      const r = await baseSession.runScript(s.sql, limits.migrationTimeoutMs);
      if (!r.ok) {
        const e = scriptError(r.error, s.path, s.sql);
        problems.push({
          kind: "baseline",
          message: `Baseline setup failed in ${s.path}${e.at ? `:${e.at.line}` : ""}: ${errorText(r.error)}`,
        });
        return finish();
      }
    }
    baselineCatalog = await baseSession.catalog();
    // The candidate starts as an exact copy of the baseline (same data, same sequence positions).
    await baseSession.close();
    baseSession = null;
    await server.createDatabase(candDb, baseDb);
    created.push(candDb);
    baseSession = await server.connect(baseDb);
    candSession = await server.connect(candDb);

    let migrationFailed = false;
    for (const m of plan.added) {
      if (migrationFailed) {
        newMigrations.push({ file: m.path, status: "not-run" });
        continue;
      }
      log(`applying ${m.path}`);
      const t = Date.now();
      const r = await candSession.runScript(m.sql, limits.migrationTimeoutMs);
      if (r.ok) newMigrations.push({ file: m.path, status: "applied", durationMs: Date.now() - t });
      else {
        migrationFailed = true;
        newMigrations.push({ file: m.path, status: "failed", error: scriptError(r.error, m.path, m.sql), durationMs: Date.now() - t });
        if (r.error.infrastructure) problems.push({ kind: "infrastructure", message: `Migration ${m.path} could not complete: ${errorText(r.error)}` });
      }
    }

    // ---- Checks
    const order = [...candProject.manifest.checks.map((c) => c.id)];
    for (const c of baseProject.manifest.checks) if (!order.includes(c.id)) order.push(c.id);
    const retired = new Map(candProject.manifest.retired.map((r) => [r.id, r.reason]));

    for (const id of order) {
      const bf = baseFixtures.get(id);
      const cf = candFixtures.get(id);
      if (!cf) {
        const reason = retired.get(id);
        checks.push({
          id,
          category: bf!.def.category,
          ...(bf!.def.description ? { description: bf!.def.description } : {}),
          classification: reason ? "retired" : "removed",
          reason: reason ? "retired" : "removed-without-retirement",
          message: reason
            ? `Check removed and retired: ${reason}`
            : "Check exists at the baseline but was removed. Restore it, or list it under \"retired\" with a reason so a reviewer can approve the removal.",
          isNew: false,
          fixtureChanged: false,
          source: null,
          baselineSource: location(bf),
          baseline: { status: "not-run" },
          candidate: { status: "not-present" },
        });
        continue;
      }
      const base: SideRun | null = bf ? await runSide(baseSession, bf, limits, deadline) : null;
      const cand: SideRun = migrationFailed ? { outcome: { status: "not-run" } } : await runSide(candSession, cf, limits, deadline);
      const fixtureChanged = !!bf && (bf.sql !== cf.sql || JSON.stringify(bf.def) !== JSON.stringify(cf.def));
      let verdict: ReturnType<typeof classify>;
      if (migrationFailed) {
        verdict = { classification: "skipped", reason: "migration-failed", message: "Not run: a candidate migration failed" };
      } else if (bf && bf.def.category !== cf.def.category) {
        verdict = { classification: "invalid-fixture", reason: "category-changed", message: `Check category changed from ${bf.def.category} to ${cf.def.category}; use a new check id` };
      } else {
        verdict = classify(base, cand, cf, sampleLimit);
      }
      checks.push({
        id,
        category: cf.def.category,
        ...(cf.def.description ? { description: cf.def.description } : {}),
        ...verdict,
        isNew: !bf,
        fixtureChanged,
        source: location(cf),
        baselineSource: location(bf),
        baseline: base ? base.outcome : { status: "not-present" },
        candidate: cand.outcome,
      });
      if (cand.error?.infrastructure && !cand.error.timeout) {
        // Reconnect so one broken connection does not poison later checks.
        await candSession.close();
        candSession = await server.connect(candDb);
      }
      if (base?.error?.infrastructure && !base.error.timeout) {
        await baseSession.close();
        baseSession = await server.connect(baseDb);
      }
    }
  } finally {
    await baseSession?.close();
    await candSession?.close();
    if (!input.keepDatabases) {
      for (const db of created.reverse()) await server.dropDatabase(db).catch(() => {});
    } else if (created.length) {
      log(`kept databases: ${created.join(", ")}`);
    }
  }
  return finish();
}
