import { ConfigError, projectFromDatabaseConfig, type LoadedProject } from "../config.ts";
import { PgServer } from "../db/postgres.ts";
import { pgErrorName } from "../db/errors.ts";
import { PathError, projectPath } from "../paths.ts";
import type { CheckFinding, Problem, Report } from "../report/types.ts";
import { baselineScripts, runChecks, type RunResult } from "../runner.ts";
import type { Source } from "../source.ts";
import { VERSION } from "../version.ts";
import { loadEnvSchema, type EnvSchemaLoad } from "../engines/env.ts";
import { loadHttpManifest, type HttpManifest } from "../engines/http.ts";
import { diffSpecs, loadSpec, type LoadedSpec, type SpecLoad } from "../engines/openapi.ts";
import { mkFinding, runRuntime, type RuntimeSide } from "../engines/runtime.ts";
import { mergeLayers, parseEffective, readConfigFileLayer, type ConfigLayer, type SuiteConfig } from "./config.ts";
import { AREAS, emptySummary, suiteExitCode, SUITE_REPORT_SCHEMA, type Area, type AreaCoverage, type Finding, type SuiteReport } from "./types.ts";

export interface Discovery {
  /** Discovered configuration (raw; parsed together with the other layers). */
  layer: ConfigLayer;
  /** What was found, in words. */
  facts: string[];
  /**
   * Exact requirements that could not be discovered. `key` names the setting that
   * would provide it (e.g. `app.start`); when an override sets it, the item is dropped.
   */
  missing: Array<{ area: Area; message: string; key?: string }>;
}

export type Discoverer = (source: Source, projectDir: string) => Promise<Discovery>;

export interface SuiteInput {
  repoRoot: string;
  projectDir: string;
  base: { ref: string; commit: string; source: Source };
  candidate: {
    label: string;
    commit: string | null;
    /** The candidate's code (SQL fixtures, specs, env schema, app). */
    source: Source;
    /** Where the candidate's runnable code lives; `commit` null exports that tree's working files. */
    code: { root: string; commit: string | null };
  };
  /**
   * Source of the candidate's EXPECTATIONS (config, check manifests). Defaults to the
   * candidate source. Repair verification passes the original, unpatched commit here,
   * so a patch can never change what it is verified against.
   */
  expectations?: Source;
  databaseUrl: string;
  /** Crashpad's stored settings for this repository (a config layer). */
  settings?: ConfigLayer;
  /** Automatic discovery; `false` disables it. */
  discover?: Discoverer | false;
  keepResources?: boolean;
  deadlineMs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface SuiteResult {
  report: SuiteReport;
  database: RunResult | null;
  baseConfig: SuiteConfig | null;
  candidateConfig: SuiteConfig | null;
}

interface Resolved {
  config: SuiteConfig;
  sources: string[];
  missing: Partial<Record<Area, string[]>>;
}

async function resolveSide(source: Source, projectDir: string, input: SuiteInput, label: string): Promise<Resolved> {
  const layers: ConfigLayer[] = [];
  const sources: string[] = [];
  let discovered: Discovery["missing"] = [];
  if (input.discover) {
    const d = await input.discover(source, projectDir);
    layers.push(d.layer);
    sources.push("discovered");
    discovered = d.missing;
  }
  if (input.settings && Object.keys(input.settings).length) {
    layers.push(input.settings);
    sources.push("Crashpad settings");
  }
  const file = await readConfigFileLayer(source, projectDir);
  if (file) {
    layers.push(file.layer);
    sources.push(file.path);
  }
  const config = parseEffective(mergeLayers(...layers), `${label} configuration (${sources.join(" + ") || "none"})`);
  const overrides = mergeLayers(...layers.slice(input.discover ? 1 : 0));
  const has = (key: string) => key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), overrides) !== undefined;
  const missing: Partial<Record<Area, string[]>> = {};
  for (const m of discovered) if (!m.key || !has(m.key)) (missing[m.area] ??= []).push(m.message);
  return { config, sources, missing };
}

function sideText(o: CheckFinding["baseline"]): string {
  switch (o.status) {
    case "ok":
      if (o.assertion !== undefined) return o.assertion === null ? "invalid result" : String(o.assertion);
      if (o.affectedRows !== undefined) return `ok, ${o.affectedRows} row(s) affected`;
      return `ok, ${o.rowCount ?? 0} row(s)${o.truncated ? " (truncated)" : ""}`;
    case "error":
      return `error ${o.error?.code ?? ""} ${o.error?.code ? pgErrorName(o.error.code) : ""}`.trim();
    case "invalid":
      return `invalid: ${o.invalidReason}`;
    case "not-present":
      return "not present";
    case "not-run":
      return "not run";
  }
}

function sideStatus(o: CheckFinding["baseline"]): Finding["baseline"]["status"] {
  return o.status === "ok" ? "pass" : o.status === "error" ? "fail" : o.status === "invalid" ? "invalid" : o.status;
}

/** Map the database engine's report onto suite findings. */
export function databaseFindings(r: Report): Finding[] {
  const out: Finding[] = [];
  for (const m of r.migrations.new) {
    const cls = m.status === "applied" ? "pass" : m.status === "failed" ? "regression" : "skipped";
    out.push({
      id: `database:migration:${m.file}`,
      area: "database",
      kind: "migration",
      title: `Migration ${m.file}`,
      classification: cls,
      reason: m.status === "failed" ? (m.error?.code ? pgErrorName(m.error.code) : "migration-failed") : m.status,
      message: m.status === "applied" ? "Applied on top of the baseline database" : m.status === "failed" ? `Migration failed: ${m.error?.message}` : "Not run: an earlier migration failed",
      isNew: true,
      subject: { file: m.error?.at?.path ?? m.file, ...(m.error?.at ? { line: m.error.at.line } : {}) },
      baseline: { status: "not-present", summary: "new in this change" },
      candidate: { status: m.status === "applied" ? "pass" : m.status === "failed" ? "fail" : "not-run", summary: m.status, ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}) },
      evidence: m.error ? [{ kind: "sql", side: "candidate", label: "migration error", detail: `${m.error.code ?? ""} ${m.error.message}${m.error.at ? ` at ${m.error.at.path}:${m.error.at.line}:${m.error.at.column}` : ""}` }] : [],
    });
  }
  for (const h of r.history) {
    if (!h.blocking) continue;
    out.push({
      id: `database:history:${h.kind}:${h.file}`,
      area: "database",
      kind: "history",
      title: `Migration history: ${h.kind}`,
      classification: "inconclusive",
      reason: h.kind,
      message: h.message,
      isNew: false,
      subject: { file: h.file },
      baseline: { status: "pass", summary: "original history" },
      candidate: { status: "invalid", summary: h.kind },
      evidence: [],
    });
  }
  for (const c of r.checks) {
    const evidence: Finding["evidence"] = [];
    if (c.candidate.error) evidence.push({ kind: "sql", side: "candidate", label: "PostgreSQL error", detail: `${c.candidate.error.code ?? ""} ${c.candidate.error.message}${c.candidate.error.at ? ` at ${c.candidate.error.at.path}:${c.candidate.error.at.line}:${c.candidate.error.at.column}` : ""}` });
    if (c.baseline.error) evidence.push({ kind: "sql", side: "baseline", label: "PostgreSQL error", detail: `${c.baseline.error.code ?? ""} ${c.baseline.error.message}` });
    if (c.columnDiff) evidence.push({ kind: "diff", label: "output columns", detail: c.columnDiff.changes.join("\n") });
    if (c.rowDiff) evidence.push({ kind: "diff", label: "rows", detail: `${c.rowDiff.missingCount} missing, ${c.rowDiff.extraCount} unexpected${c.rowDiff.samples ? `\n${JSON.stringify(c.rowDiff.samples)}` : ""}` });
    const loc = c.candidate.error?.at ?? (c.source ? { path: c.source.path, line: c.source.line } : null);
    out.push({
      id: `database:${c.id}`,
      area: "database",
      kind: c.category,
      title: c.description ?? c.id,
      classification: c.classification,
      reason: c.reason,
      message: c.message,
      isNew: c.isNew,
      subject: loc ? { file: loc.path, line: loc.line, operation: c.id } : { operation: c.id },
      baseline: { status: sideStatus(c.baseline), summary: sideText(c.baseline), ...(c.baseline.durationMs !== undefined ? { durationMs: c.baseline.durationMs } : {}) },
      candidate: { status: sideStatus(c.candidate), summary: sideText(c.candidate), ...(c.candidate.durationMs !== undefined ? { durationMs: c.candidate.durationMs } : {}) },
      evidence,
      ...(c.source?.kind === "file" ? { reproduce: `crashpad check --base ${r.base.commit.slice(0, 12)} --keep-databases, then run ${c.source.path} against the crashpad_cand_* database` } : {}),
    });
  }
  return out;
}

/** Static OpenAPI comparison: the baseline contract vs the candidate's contract. */
export function specFindings(baseLoad: SpecLoad | null, candLoad: SpecLoad | null, candPath: string): { findings: Finding[]; ran: string[]; missing: string[] } {
  const findings: Finding[] = [];
  const ran: string[] = [];
  const missing: string[] = [];
  const f = (id: string, title: string, cls: Finding["classification"], reason: string, message: string, b: Finding["baseline"], c: Finding["candidate"], subject: Finding["subject"], isNew = false) =>
    mkFinding("api", id, "spec", title, cls, reason, message, b, c, [], isNew, subject);
  if (!baseLoad || (!baseLoad.ok && baseLoad.missing)) {
    if (candLoad?.ok) {
      ran.push(`OpenAPI ${candLoad.spec.version} document ${candPath} validated (no baseline contract to compare against)`);
      findings.push(f("spec:valid", "OpenAPI document is valid", "pass", "ok", "New contract parses and validates", { status: "not-present", summary: "no contract" }, { status: "pass", summary: "valid" }, { file: candPath }, true));
      missing.push("no baseline OpenAPI contract, so breaking changes cannot be compared yet");
    } else if (candLoad && !candLoad.ok && !candLoad.missing) {
      findings.push(f("spec:valid", "OpenAPI document is valid", "regression", "invalid-spec", candLoad.message, { status: "not-present", summary: "no contract" }, { status: "fail", summary: candLoad.message }, { file: candPath }, true));
    }
    return { findings, ran, missing };
  }
  if (!baseLoad.ok) {
    findings.push(f("spec:valid", "Baseline OpenAPI contract", "baseline-failure", "invalid-baseline-spec", `The baseline contract is invalid, so it cannot be compared: ${baseLoad.message}`, { status: "invalid", summary: baseLoad.message }, { status: "not-run", summary: "not compared" }, { file: candPath }));
    return { findings, ran, missing };
  }
  if (!candLoad || !candLoad.ok) {
    const msg = !candLoad || candLoad.missing ? `The OpenAPI contract ${baseLoad.spec.path} existed at the baseline but is missing now` : candLoad.message;
    findings.push(f("spec:valid", "OpenAPI contract", "regression", !candLoad || candLoad.missing ? "spec-removed" : "invalid-spec", msg, { status: "pass", summary: "valid" }, { status: "fail", summary: msg }, { file: candPath }));
    return { findings, ran, missing };
  }
  const { operations, changes } = diffSpecs(baseLoad.spec.doc, candLoad.spec.doc);
  ran.push(`OpenAPI comparison of ${operations.length} baseline operation(s) (static specification diff, not runtime behavior)`);
  const byOp = new Map<string, typeof changes>();
  for (const ch of changes) (byOp.get(ch.operation) ?? byOp.set(ch.operation, []).get(ch.operation)!).push(ch);
  for (const op of operations) {
    const list = byOp.get(op) ?? [];
    if (!list.length) {
      findings.push(f(`spec:${op}`, `${op} contract`, "pass", "ok", "No breaking changes to this operation", { status: "pass", summary: "baseline contract" }, { status: "pass", summary: "compatible" }, { file: candLoad.spec.path, operation: op }));
      continue;
    }
    for (const ch of list) {
      findings.push({
        ...f(`spec:${op}:${ch.rule}:${ch.location}`, `${op}: ${ch.rule}`, "regression", ch.rule, `Breaking contract change: ${ch.message}`, { status: "pass", summary: "baseline contract" }, { status: "fail", summary: ch.message }, { file: candLoad.spec.path, operation: op }),
        evidence: [{ kind: "spec", label: "location", detail: `${op} ${ch.location || "(operation)"}` }],
      });
    }
  }
  return { findings, ran, missing };
}

function coverageOf(area: Area, ran: string[], missing: string[], unavailable: string[], applicable: boolean): AreaCoverage {
  let status: AreaCoverage["status"];
  if (unavailable.length && !ran.length) status = "unavailable";
  else if (ran.length && !missing.length && !unavailable.length) status = "complete";
  else if (ran.length) status = "partial";
  else if (missing.length || applicable) status = "not-configured";
  else status = "not-applicable";
  return { area, status, ran, missing: [...unavailable, ...missing] };
}

function headline(r: SuiteReport): string {
  if (r.problems.length) return `Could not complete: ${r.problems[0]!.message}`;
  const s = r.summary;
  const bad = s.regression + s["changed-result"] + s["failed-assertion"] + s.removed;
  const partial = r.complete ? "" : " (partial coverage; see Coverage)";
  if (bad) return `${bad} of ${s.total} check(s) broke${partial}`;
  const undecided = s["baseline-failure"] + s["invalid-fixture"] + s.inconclusive + s.skipped;
  if (undecided) return `${undecided} check(s) could not be decided${partial}`;
  if (!s.pass) return "Nothing was verified: no applicable checks ran";
  return `All ${s.pass} check(s) passed${partial}`;
}

export async function runSuite(input: SuiteInput): Promise<SuiteResult> {
  const started = Date.now();
  const log = input.log ?? (() => {});
  const deadline = started + (input.deadlineMs ?? 30 * 60_000);
  const problems: Problem[] = [];
  const findings: Finding[] = [];
  const ran: Record<Area, string[]> = { database: [], api: [], config: [], permissions: [], workflows: [] };
  const missing: Record<Area, string[]> = { database: [], api: [], config: [], permissions: [], workflows: [] };
  const unavailable: Record<Area, string[]> = { database: [], api: [], config: [], permissions: [], workflows: [] };
  const applicable = new Set<Area>();
  const expectations = input.expectations ?? input.candidate.source;
  let base: Resolved | null = null;
  let cand: Resolved | null = null;
  let dbResult: RunResult | null = null;
  let server: PgServer | null = null;

  const finish = (): SuiteResult => {
    const coverage = AREAS.map((a) => coverageOf(a, ran[a], missing[a], unavailable[a], applicable.has(a)));
    const summary = emptySummary();
    for (const f of findings) {
      summary[f.classification]++;
      summary.total++;
    }
    const exitCode = suiteExitCode({ problems, findings, coverage });
    const report: SuiteReport = {
      schemaVersion: SUITE_REPORT_SCHEMA,
      tool: { name: "crashpad", version: VERSION },
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      project: input.projectDir,
      base: { ref: input.base.ref, commit: input.base.commit },
      candidate: { label: input.candidate.label, commit: input.candidate.commit },
      configSources: cand?.sources ?? [],
      exitCode,
      status: exitCode === 0 ? "pass" : exitCode === 1 ? "fail" : "error",
      complete: coverage.every((c) => c.status === "complete" || c.status === "not-applicable"),
      headline: "",
      coverage,
      problems,
      findings,
      summary,
      ...(dbResult ? { database: dbResult.report } : {}),
    };
    report.headline = headline(report);
    return { report, database: dbResult, baseConfig: base?.config ?? null, candidateConfig: cand?.config ?? null };
  };

  try {
    base = await resolveSide(input.base.source, input.projectDir, input, `baseline ${input.base.ref}`);
    cand = await resolveSide(expectations, input.projectDir, input, input.candidate.label);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof PathError) {
      problems.push({ kind: "config", message: err.message });
      return finish();
    }
    throw err;
  }
  for (const a of AREAS) missing[a].push(...(cand.missing[a] ?? []));
  const bc = base.config;
  const cc = cand.config;

  // ---- 1. Database compatibility
  if (bc.database || cc.database) {
    applicable.add("database");
    server = new PgServer(input.databaseUrl);
    log("database: running checks");
    const loader = async (src: Source, dir: string, side: "base" | "candidate"): Promise<LoadedProject | null> => {
      const db = side === "base" ? bc.database : cc.database;
      if (!db) return null;
      return projectFromDatabaseConfig(side === "base" ? input.base.source : expectations, dir, db, side === "base" ? base!.sources.join(" + ") || "(none)" : cand!.sources.join(" + ") || "(none)");
    };
    try {
      dbResult = await runChecks({
        projectDir: input.projectDir,
        base: input.base,
        candidate: { label: input.candidate.label, commit: input.candidate.commit, source: input.candidate.source },
        server,
        loadProject: loader,
        ...(input.keepResources ? { keepDatabases: true } : {}),
        log,
      });
    } catch (err) {
      if (err instanceof ConfigError || err instanceof PathError) problems.push({ kind: "config", message: err.message });
      else throw err;
    }
    if (dbResult) {
      const r = dbResult.report;
      for (const p of r.problems) {
        if (p.kind === "infrastructure" || p.kind === "baseline") unavailable.database.push(p.message);
        problems.push(p);
      }
      findings.push(...databaseFindings(r));
      if (!r.problems.length) {
        ran.database.push(`baseline database built (${r.migrations.baseline.length} baseline migration(s)); ${r.migrations.new.length} new migration(s) applied to the candidate`);
        ran.database.push("migration history validated");
        if (r.checks.length) ran.database.push(`${r.checks.length} read/write/assertion check(s)`);
        else missing.database.push("no read, write, or assertion checks configured; only migration execution and history were checked");
      }
    }
  }

  // ---- 2. API contracts (static part)
  const baseSpecPath = bc.api?.openapi;
  const candSpecPath = cc.api?.openapi ?? baseSpecPath;
  let contract: LoadedSpec | null = null;
  if (baseSpecPath || candSpecPath) {
    applicable.add("api");
    const at = (p: string) => projectPath(input.projectDir, p, "api.openapi");
    const bl = baseSpecPath ? await loadSpec(input.base.source, at(baseSpecPath)) : null;
    const cl = candSpecPath ? await loadSpec(input.candidate.source, at(candSpecPath)) : null;
    if (bl?.ok) contract = bl.spec;
    const r = specFindings(bl, cl, at(candSpecPath!));
    findings.push(...r.findings);
    ran.api.push(...r.ran);
    missing.api.push(...r.missing);
  }

  // ---- 3–5. Runtime: configuration/startup, API behavior, permissions, workflows
  if (cc.app?.start) {
    for (const a of ["config", "permissions", "workflows"] as const) applicable.add(a);
    if (contract || cc.http) applicable.add("api");
    if (!bc.app?.start) {
      missing.config.push("the baseline has no application start configuration; runtime checks need one on both versions");
    } else {
      const dbScripts = async (side: "base" | "candidate"): Promise<{ scripts: RuntimeSide["dbScripts"]; unavailable?: string }> => {
        if (!dbResult?.baseProject || !dbResult.migrations) return { scripts: (side === "base" ? bc : cc).database ? [] : null, ...((side === "base" ? bc : cc).database ? { unavailable: "the database could not be built (see the database area)" } : {}) };
        const p = dbResult.baseProject;
        const schemaSql = p.paths.schema ? ((await input.base.source.readFile(p.paths.schema)) ?? "") : "";
        const seedSql = p.paths.seed ? await input.base.source.readFile(p.paths.seed) : null;
        const scripts = baselineScripts(p, schemaSql, seedSql, dbResult.migrations);
        if (side === "candidate") {
          scripts.push(...dbResult.migrations.added.map((m) => ({ path: m.path, sql: m.sql })));
          if (dbResult.report.migrations.new.some((m) => m.status === "failed")) return { scripts, unavailable: "a candidate migration failed (see the database area)" };
        }
        return { scripts };
      };
      const at = (p: string, what: string) => projectPath(input.projectDir, p, what);
      const envOf = async (src: Source, c: SuiteConfig): Promise<EnvSchemaLoad | null> => (c.app?.envSchema ? loadEnvSchema(src, { ...c.app.envSchema, path: at(c.app.envSchema.path, "app.envSchema.path") }) : null);
      const httpOf = async (src: Source, c: SuiteConfig): Promise<HttpManifest | null> => (c.http ? loadHttpManifest(src, at(c.http.checks, "http.checks")) : null);
      try {
        const bScripts = await dbScripts("base");
        const cScripts = await dbScripts("candidate");
        const mk = async (which: "base" | "candidate"): Promise<RuntimeSide> => {
          const c = which === "base" ? bc : cc;
          const s = which === "base" ? bScripts : cScripts;
          return {
            label: which === "base" ? input.base.ref : input.candidate.label,
            code: which === "base" ? { root: input.repoRoot, commit: input.base.commit } : input.candidate.code,
            app: c.app!,
            projectDir: input.projectDir,
            dbScripts: s.scripts,
            ...(s.unavailable ? { dbUnavailable: s.unavailable } : {}),
            envSchema: await envOf(which === "base" ? input.base.source : input.candidate.source, c),
            http: await httpOf(which === "base" ? input.base.source : expectations, c),
          };
        };
        if ((bc.database || cc.database) && !server) server = new PgServer(input.databaseUrl);
        const rt = await runRuntime({
          base: await mk("base"),
          candidate: await mk("candidate"),
          contract,
          smoke: cc.api?.smoke ?? true,
          server,
          migrationTimeoutMs: dbResult?.candProject?.config.limits.migrationTimeoutMs ?? 60_000,
          deadline,
          ...(input.signal ? { signal: input.signal } : {}),
          log,
          ...(input.keepResources ? { keep: true } : {}),
        });
        findings.push(...rt.findings);
        for (const a of AREAS) {
          ran[a].push(...(rt.ran[a] ?? []));
          missing[a].push(...(rt.missing[a] ?? []));
          unavailable[a].push(...(rt.unavailable[a] ?? []));
        }
      } catch (err) {
        if (err instanceof ConfigError || err instanceof PathError) problems.push({ kind: "config", message: err.message });
        else throw err;
      }
    }
  } else {
    if (!missing.config.length) missing.config.push("no application start command configured or discovered; startup, runtime API, permission, and workflow checks need one");
    if (cc.http) missing.permissions.push("permission scenarios are configured but there is no application start command to run them");
  }
  return finish();
}
