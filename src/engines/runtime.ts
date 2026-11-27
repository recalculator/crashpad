import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PgServer, type PgSession } from "../db/postgres.ts";
import { errorText, runScript } from "../runner.ts";
import type { AppConfig } from "../suite/config.ts";
import type { Area, Evidence, Finding, SideResult } from "../suite/types.ts";
import type { Classification } from "../report/types.ts";
import { AppProcess, freePort, materialize, runCommand, tempWorkdir, type StartOutcome } from "./app.ts";
import { buildTestEnv, redactValue, validateEnv, type EnvSchema, type EnvSchemaLoad } from "./env.ts";
import { expandSteps, runScenario, type HttpCheck, type HttpManifest, type ScenarioRun } from "./http.ts";
import { operations, type LoadedSpec } from "./openapi.ts";

/**
 * Runtime checks run the application itself, once per version:
 * - the code of each version is exported (exact commit, or the working tree)
 *   into a temporary directory and its dependencies are installed there;
 * - with a database, a template database is built per version (schema → seed →
 *   that version's migrations);
 * - every scenario gets a fresh clone of that template and a fresh application
 *   process, so scenarios cannot contaminate one another.
 */

export interface RuntimeSide {
  label: string;
  /** Repository (or workspace) holding the code; `commit` null means its working tree. */
  code: { root: string; commit: string | null };
  app: AppConfig;
  /** Project directory relative to the repository root. */
  projectDir: string;
  /** Scripts that build this version's database, or null without a database. */
  dbScripts: Array<{ path: string; sql: string }> | null;
  /** Set when this version's migrations failed (runtime checks cannot run on it). */
  dbUnavailable?: string;
  envSchema: EnvSchemaLoad | null;
  http: HttpManifest | null;
}

export interface RuntimeInput {
  base: RuntimeSide;
  candidate: RuntimeSide;
  /** The baseline OpenAPI contract: responses are validated against it on both versions. */
  contract: LoadedSpec | null;
  smoke: boolean;
  server: PgServer | null;
  migrationTimeoutMs: number;
  deadline: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  keep?: boolean;
}

export interface RuntimeResult {
  findings: Finding[];
  ran: Partial<Record<Area, string[]>>;
  missing: Partial<Record<Area, string[]>>;
  unavailable: Partial<Record<Area, string[]>>;
}

type SideOutcome =
  | { status: "pass"; summary: string; evidence: Evidence[]; durationMs?: number }
  | { status: "fail"; summary: string; evidence: Evidence[]; durationMs?: number }
  | { status: "error"; summary: string; evidence: Evidence[]; crashed: boolean; durationMs?: number }
  | { status: "not-run"; summary: string; evidence: Evidence[]; startupFailed?: boolean };

function toSide(o: SideOutcome | null): SideResult {
  if (!o) return { status: "not-present", summary: "not defined in this version" };
  return { status: o.status, summary: o.summary, ...("durationMs" in o && o.durationMs !== undefined ? { durationMs: o.durationMs } : {}) };
}

/** The same decision rules as the database engine, for runtime outcomes. */
export function classifyRuntime(base: SideOutcome | null, cand: SideOutcome): { classification: Classification; reason: string; message: string } {
  if (base) {
    if (base.status === "not-run") {
      return base.startupFailed
        ? { classification: "baseline-failure", reason: "baseline-did-not-start", message: `The baseline application did not start, so this check cannot vouch for the change: ${base.summary}` }
        : { classification: "inconclusive", reason: "baseline-not-run", message: `Baseline not run: ${base.summary}` };
    }
    if (base.status === "fail") return { classification: "baseline-failure", reason: "failing-at-baseline", message: `Already failing before this change: ${base.summary}` };
    if (base.status === "error") return { classification: "inconclusive", reason: "baseline-error", message: `Baseline could not be checked: ${base.summary}` };
  }
  if (cand.status === "pass") return { classification: "pass", reason: "ok", message: base ? "Same behavior as baseline" : "New check passes" };
  if (cand.status === "fail") return { classification: "regression", reason: "expectation-failed", message: base ? `Passed before, fails now: ${cand.summary}` : `New check fails: ${cand.summary}` };
  if (cand.status === "error") {
    return cand.crashed
      ? { classification: "regression", reason: "app-crashed", message: `The application exited during the check: ${cand.summary}` }
      : { classification: "inconclusive", reason: "candidate-error", message: `Candidate could not be checked: ${cand.summary}` };
  }
  return cand.startupFailed
    ? { classification: "skipped", reason: "candidate-did-not-start", message: "Not run: the candidate application did not start (see the startup finding)" }
    : { classification: "inconclusive", reason: "candidate-not-run", message: `Not run: ${cand.summary}` };
}

interface PreparedSide {
  side: RuntimeSide;
  dir: string;
  appDir: string;
  template: string | null;
  ready: boolean;
  problem?: string;
  /** The build command failed (a code problem, unlike an install failure, which may be infrastructure). */
  buildFailed?: boolean;
}

function startSummary(o: StartOutcome, readiness: AppConfig["readiness"]): string {
  switch (o.status) {
    case "ready":
      return `ready in ${o.readyMs} ms${readiness.path ? ` (GET ${readiness.path} → 2xx)` : " (port accepting connections)"}`;
    case "exited":
      return `exited before becoming ready (exit code ${o.code ?? "none"}${o.signal ? `, signal ${o.signal}` : ""}) after ${o.afterMs} ms`;
    case "readiness-timeout":
      return `not ready within ${readiness.timeoutMs} ms (last probe: ${o.lastProbe})`;
    case "spawn-failed":
      return `could not start: ${o.message}`;
  }
}

function lastLines(text: string, n = 40): string {
  return text.trimEnd().split("\n").slice(-n).join("\n");
}

export async function runRuntime(input: RuntimeInput): Promise<RuntimeResult> {
  const log = input.log ?? (() => {});
  const findings: Finding[] = [];
  const ran: RuntimeResult["ran"] = {};
  const missing: RuntimeResult["missing"] = {};
  const unavailable: RuntimeResult["unavailable"] = {};
  const add = (bag: RuntimeResult["ran"], area: Area, msg: string) => ((bag[area] ??= []).push(msg));
  const cleanup: Array<() => Promise<void>> = [];
  const server = input.server;

  const prepare = async (side: RuntimeSide, which: "baseline" | "candidate"): Promise<PreparedSide> => {
    const dir = await tempWorkdir(`${which}`);
    if (!input.keep) cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const appDir = path.join(dir, side.projectDir === "." ? "" : side.projectDir, side.app.root === "." ? "" : side.app.root);
    const p: PreparedSide = { side, dir, appDir, template: null, ready: false };
    try {
      log(`${which}: exporting ${side.code.commit ? side.code.commit.slice(0, 12) : "working tree"}`);
      await materialize(side.code.root, side.code.commit, dir);
    } catch (err) {
      p.problem = `could not export the ${which} code: ${(err as Error).message}`;
      return p;
    }
    if (side.app.install) {
      log(`${which}: ${side.app.install.join(" ")}`);
      const r = await runCommand(side.app.install, { cwd: appDir, env: buildTestEnv({ schema: null, useExampleValues: false, explicit: {}, generated: {} }).env, timeoutMs: side.app.installTimeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
      if (!r.ok) {
        p.problem = `dependency install failed for the ${which} (\`${side.app.install.join(" ")}\`${r.timedOut ? `, timed out after ${side.app.installTimeoutMs} ms` : `, exit ${r.code}`}):\n${lastLines(r.output, 20)}`;
        return p;
      }
    }
    if (side.app.build) {
      log(`${which}: ${side.app.build.join(" ")}`);
      const r = await runCommand(side.app.build, { cwd: appDir, env: buildTestEnv({ schema: null, useExampleValues: false, explicit: {}, generated: {} }).env, timeoutMs: side.app.installTimeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
      if (!r.ok) {
        p.problem = `build failed for the ${which} (\`${side.app.build.join(" ")}\`, exit ${r.code}):\n${lastLines(r.output, 20)}`;
        p.buildFailed = !r.timedOut && !r.cancelled;
        return p;
      }
    }
    if (side.dbScripts) {
      if (side.dbUnavailable) {
        p.problem = side.dbUnavailable;
        return p;
      }
      if (!server) {
        p.problem = "the project has a database but no PostgreSQL server is available";
        return p;
      }
      const name = PgServer.uniqueName(which === "baseline" ? "rtb" : "rtc");
      await server.createDatabase(name);
      if (!input.keep) cleanup.push(() => server.dropDatabase(name).catch(() => {}));
      const s = await server.connect(name);
      try {
        for (const sc of side.dbScripts) {
          const r = await runScript(s, sc.sql, input.migrationTimeoutMs);
          if (!r.ok) {
            p.problem = `could not build the ${which} database: ${sc.path}: ${errorText(r.error)}`;
            return p;
          }
        }
      } finally {
        await s.close();
      }
      p.template = name;
    }
    p.ready = true;
    return p;
  };

  /** Fresh database clone + fresh app process; run `fn` once the app is ready. */
  const withApp = async <T>(p: PreparedSide, fn: ((app: AppProcess, db: PgSession | null) => Promise<T>) | null) => {
    const app = p.side.app;
    let clone: string | null = null;
    let session: PgSession | null = null;
    const generated: Record<string, string> = {};
    const port = await freePort();
    generated[app.portEnv] = String(port);
    if (p.template && server) {
      clone = PgServer.uniqueName("rtx");
      await server.createDatabase(clone, p.template);
      generated[app.databaseUrlEnv] = server.appDatabaseUrl(clone);
    }
    const schema = p.side.envSchema?.ok ? p.side.envSchema.schema : null;
    const { env, appKeys } = buildTestEnv({ schema, useExampleValues: app.useExampleValues, explicit: app.env, generated });
    const proc = new AppProcess({ command: app.start, cwd: p.appDir, env, port });
    try {
      const start = await proc.start(app.readiness, input.signal);
      let value: T | undefined;
      if (start.status === "ready" && fn) {
        if (clone && server) session = await server.connect(clone);
        value = await fn(proc, session);
      }
      return { start, value, logs: proc.logs(), appKeys, env, exited: proc.exitInfo() };
    } finally {
      await proc.stop();
      await session?.close();
      if (clone && server && !input.keep) await server.dropDatabase(clone).catch(() => {});
    }
  };

  try {
    const base = await prepare(input.base, "baseline");
    const cand = await prepare(input.candidate, "candidate");
    for (const [p, which] of [[base, "baseline"], [cand, "candidate"]] as const) {
      if (p.problem) add(unavailable, "config", `${which}: ${p.problem}`);
    }

    // ---- Configuration: environment contract.
    const envFinding = (): Finding[] => {
      const out: Finding[] = [];
      const bs = input.base.envSchema;
      const cs = input.candidate.envSchema;
      if (!cs && !bs) {
        add(missing, "config", "no environment schema (.env.example or a JSON Schema) was found; required variables cannot be validated");
        return out;
      }
      if (cs && !cs.ok) {
        out.push(mkFinding("config", "env:schema", "env", "Environment schema", "regression", cs.missing ? "env-schema-removed" : "env-schema-invalid", cs.missing ? `The environment schema ${cs.path} existed at the baseline but is missing now` : cs.message, { status: bs?.ok ? "pass" : "not-present", summary: bs?.ok ? "schema valid" : "no schema" }, { status: "fail", summary: cs.message }, [], !bs, { file: cs.path }));
        return out;
      }
      const baseEnvIssues = bs?.ok ? validateEnv(bs.schema, envFor(input.base, bs.schema)) : null;
      const candSchema = (cs as { ok: true; schema: EnvSchema }).schema;
      const candEnv = envFor(input.candidate, candSchema);
      const candIssues = validateEnv(candSchema, candEnv);
      add(ran, "config", `environment validated against ${candSchema.path} (${candSchema.format}, ${candSchema.required.length} required variable(s))`);
      for (const issue of candIssues) {
        const atBase = baseEnvIssues?.find((b) => b.name === issue.name && b.kind === issue.kind);
        const classification: Classification = atBase ? "baseline-failure" : "regression";
        out.push(
          mkFinding(
            "config",
            `env:${issue.name}`,
            "env",
            `Environment variable ${issue.name}`,
            classification,
            issue.kind === "missing" ? "missing-required-env" : "invalid-env-value",
            atBase ? `Already a problem before this change: ${issue.message}` : `${issue.message}${issue.kind === "missing" ? ". Deployments must define it; if they do, add a test value to Crashpad's settings for this repository (app.env)." : ""}`,
            { status: atBase ? "fail" : "pass", summary: atBase ? atBase.message : "satisfied" },
            { status: "fail", summary: issue.message },
            [{ kind: "env", side: "candidate", label: "test environment keys", detail: Object.keys(candEnv).sort().join(", ") || "(none)" }],
            !baseEnvIssues,
            { file: candSchema.path, ...(issue.line ? { line: issue.line } : {}), operation: issue.name },
          ),
        );
      }
      if (!candIssues.length) {
        out.push(mkFinding("config", "env:schema", "env", `Environment satisfies ${candSchema.path}`, "pass", "ok", "Every required variable has a valid test value", { status: baseEnvIssues ? (baseEnvIssues.length ? "fail" : "pass") : "not-present", summary: baseEnvIssues ? `${baseEnvIssues.length} issue(s)` : "no schema" }, { status: "pass", summary: `${candSchema.required.length} required variable(s) satisfied` }, [], !baseEnvIssues, { file: candSchema.path }));
      }
      return out;
    };
    findings.push(...envFinding());

    // ---- Configuration: startup and readiness.
    const startupOf = async (p: PreparedSide, which: "baseline" | "candidate") => {
      if (!p.ready) return { outcome: { status: "not-run", summary: p.problem ?? "not prepared", evidence: [] } as SideOutcome, ok: false };
      const r = await withApp(p, null);
      const ok = r.start.status === "ready";
      const evidence: Evidence[] = [
        { kind: "note", side: which, label: "command", detail: `cd ${path.posix.join(p.side.projectDir, p.side.app.root)} && ${p.side.app.start.join(" ")}  (env: ${r.appKeys.join(", ")})` },
      ];
      if (!ok || r.logs.trim()) evidence.push({ kind: "log", side: which, label: "application output (last lines)", detail: lastLines(r.logs) || "(no output)" });
      const summary = startSummary(r.start, p.side.app.readiness);
      return { outcome: ok ? ({ status: "pass", summary, evidence, durationMs: (r.start as { readyMs: number }).readyMs } as SideOutcome) : ({ status: "fail", summary, evidence } as SideOutcome), ok };
    };
    log("checking startup and readiness");
    const bStart = await startupOf(base, "baseline");
    const cStart = await startupOf(cand, "candidate");
    {
      let verdict = classifyRuntime(bStart.outcome, cStart.outcome);
      if (bStart.outcome.status === "not-run") verdict = { classification: "inconclusive", reason: "baseline-not-prepared", message: `Baseline could not be prepared: ${bStart.outcome.summary}` };
      else if (cStart.outcome.status === "not-run" && cand.buildFailed && bStart.ok) verdict = { classification: "regression", reason: "build-failed", message: `Built and started before this change; now ${cStart.outcome.summary}` };
      else if (cStart.outcome.status === "not-run") verdict = { classification: "inconclusive", reason: "candidate-not-prepared", message: `Candidate could not be prepared: ${cStart.outcome.summary}` };
      else if (verdict.reason === "expectation-failed") verdict = { classification: "regression", reason: cStart.outcome.summary.startsWith("not ready") ? "readiness-timeout" : "startup-failed", message: `Started before this change; now ${cStart.outcome.summary}` };
      findings.push(
        mkFinding("config", "startup", "startup", "Application startup and readiness", verdict.classification, verdict.reason, verdict.message, toSide(bStart.outcome), toSide(cStart.outcome), [...bStart.outcome.evidence, ...cStart.outcome.evidence], false, {
          operation: input.candidate.app.start.join(" "),
        }),
      );
      add(ran, "config", `startup and readiness within ${input.candidate.app.readiness.timeoutMs} ms (${input.candidate.app.readiness.path ? `GET ${input.candidate.app.readiness.path}` : "port open"})`);
    }

    // ---- HTTP checks: configured scenarios and spec-derived smoke checks.
    const checks: Array<{ id: string; area: Area; title: string; base: HttpCheck | null; cand: HttpCheck | null; changed: boolean; smoke?: boolean }> = [];
    const bChecks = new Map((input.base.http?.checks ?? []).map((c) => [c.id, c]));
    const cChecks = new Map((input.candidate.http?.checks ?? []).map((c) => [c.id, c]));
    const retired = new Map((input.candidate.http?.retired ?? []).map((r) => [r.id, r.reason]));
    for (const [id, c] of cChecks) {
      const b = bChecks.get(id) ?? null;
      // Existing checks keep their BASELINE definition on both versions: a change cannot pass
      // by editing its own expectations. To change one, retire it and add a new id.
      checks.push({ id, area: c.area, title: c.description ?? id, base: b, cand: b ?? c, changed: !!b && JSON.stringify(b) !== JSON.stringify(c) });
    }
    for (const [id, b] of bChecks) {
      if (cChecks.has(id)) continue;
      const reason = retired.get(id);
      findings.push(
        mkFinding(b.area, id, b.area === "permissions" ? "permission" : b.area === "workflows" ? "workflow" : "runtime", b.description ?? id, reason ? "retired" : "removed", reason ? "retired" : "removed-without-retirement", reason ? `Check removed and retired: ${reason}` : 'Check exists at the baseline but was removed. Restore it, or list it under "retired" with a reason so a reviewer can approve the removal.', { status: "not-run", summary: "not run" }, { status: "not-present", summary: "removed" }, [], false, { operation: id }),
      );
    }
    if (input.smoke && input.contract) {
      const doc = input.contract.doc;
      for (const op of operations(doc).values()) {
        if (op.method !== "GET") continue;
        if (op.params.some((p) => p.required)) continue;
        const sec = op.op.security ?? doc.security ?? [];
        if (Array.isArray(sec) && sec.length > 0 && !sec.some((s: object) => Object.keys(s).length === 0)) continue;
        const smokeId = `smoke:GET ${op.path}`;
        const check: HttpCheck = { id: smokeId, area: "api", steps: [{ request: { method: "GET", path: op.path }, expect: { contract: true } }] };
        checks.push({ id: smokeId, area: "api", title: `GET ${op.path} (spec-derived smoke check)`, base: check, cand: check, changed: false, smoke: true });
      }
    }
    const scenario = async (p: PreparedSide, which: "baseline" | "candidate", check: HttpCheck, manifest: HttpManifest | null, startedOk: boolean): Promise<SideOutcome> => {
      if (!p.ready || !startedOk) return { status: "not-run", summary: p.problem ?? "the application did not start", evidence: [], startupFailed: (p.ready && !startedOk) || !!p.buildFailed };
      if (Date.now() > input.deadline) return { status: "not-run", summary: "run deadline reached", evidence: [] };
      const r = await withApp(p, (app, db) =>
        runScenario(check, {
          baseUrl: app.baseUrl,
          manifest: manifest ?? { version: 1, identities: {}, checks: [], retired: [] },
          contract: input.contract,
          db,
          requestTimeoutMs: p.side.app.requestTimeoutMs,
          deadline: Math.min(input.deadline, Date.now() + p.side.app.scenarioTimeoutMs),
          runId: randomBytes(4).toString("hex"),
          side: which,
          appAlive: () => !app.hasExited(),
        }),
      );
      if (r.start.status !== "ready") return { status: "error", summary: `application did not start for this scenario: ${startSummary(r.start, p.side.app.readiness)}`, evidence: [{ kind: "log", side: which, label: "application output", detail: lastLines(r.logs) }], crashed: false };
      const run = r.value as ScenarioRun;
      const ev = [...run.evidence];
      if (run.status !== "pass" && r.logs.trim()) ev.push({ kind: "log", side: which, label: "application output (last lines)", detail: lastLines(r.logs, 25) });
      if (run.status === "pass") return { status: "pass", summary: `${expandSteps(check).length} step(s) passed`, evidence: ev, durationMs: run.durationMs };
      const where = `${run.failure!.stepName}: ${run.failure!.message}`;
      if (run.status === "fail") return { status: "fail", summary: where, evidence: ev, durationMs: run.durationMs };
      return { status: "error", summary: where, evidence: ev, crashed: r.exited !== null, durationMs: run.durationMs };
    };

    for (const c of checks) {
      log(`runtime check ${c.id}`);
      const kind = c.area === "permissions" ? "permission" : c.area === "workflows" ? "workflow" : c.smoke ? "smoke" : "runtime";
      const b = c.base ? await scenario(base, "baseline", c.base, input.base.http, bStart.ok) : null;
      const cOut = await scenario(cand, "candidate", c.cand!, c.base ? input.base.http : input.candidate.http, cStart.ok);
      const verdict = classifyRuntime(b, cOut);
      // The candidate's evidence first: that is where a regression shows.
      const evidence: Evidence[] = [...cOut.evidence, ...(b?.evidence ?? [])];
      if (c.changed) evidence.unshift({ kind: "note", label: "definition changed", detail: "The candidate edits this check's definition. The baseline definition was enforced on both versions; to change an expectation, retire this id and add a new check." });
      const first = (c.cand && "request" in c.cand && !("steps" in c.cand) ? `${c.cand.request.method} ${c.cand.request.path}` : expandSteps(c.cand!).find((s) => s.request)?.request);
      const operation = typeof first === "string" ? first : first ? `${first.method} ${first.path}` : c.id;
      findings.push(mkFinding(c.area, c.id, kind, c.title, verdict.classification, verdict.reason, verdict.message, toSide(b), toSide(cOut), evidence, !c.base, { operation }));
      add(ran, c.area, c.smoke ? `spec-derived smoke check ${c.id.slice(6)}` : `scenario ${c.id}`);
    }
    if (!input.candidate.http) {
      add(missing, "permissions", "no permission scenarios configured (crashpad.http.json); expected access policies cannot be discovered and are never inferred");
      add(missing, "workflows", "no workflow scenarios configured (crashpad.http.json)");
    } else {
      if (!checks.some((c) => c.area === "permissions")) add(missing, "permissions", "no permission scenarios in the HTTP manifest");
      if (!checks.some((c) => c.area === "workflows")) add(missing, "workflows", "no workflow scenarios in the HTTP manifest");
    }
    if (!checks.some((c) => c.area === "api")) add(missing, "api", input.contract ? "no runtime API checks: the contract has no parameterless public GET operations and none are configured" : "no runtime API checks configured and no OpenAPI contract to derive them from");
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }
  return { findings, ran, missing, unavailable };
}

function envFor(side: RuntimeSide, schema: EnvSchema): Record<string, string> {
  const generated: Record<string, string> = { [side.app.portEnv]: "0" };
  if (side.dbScripts) generated[side.app.databaseUrlEnv] = "postgres://crashpad-test-database";
  const { env, appKeys } = buildTestEnv({ schema, useExampleValues: side.app.useExampleValues, explicit: side.app.env, generated });
  return Object.fromEntries(appKeys.map((k) => [k, env[k]!]));
}

export function mkFinding(
  area: Area,
  id: string,
  kind: string,
  title: string,
  classification: Classification,
  reason: string,
  message: string,
  baseline: SideResult,
  candidate: SideResult,
  evidence: Evidence[],
  isNew: boolean,
  subject: Finding["subject"],
): Finding {
  return { id: `${area}:${id}`, area, kind, title, classification, reason, message, isNew, subject, baseline, candidate, evidence };
}

export { redactValue };
