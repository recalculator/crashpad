import { ACTIONABLE, UNDECIDED, type Classification, type Problem, type Report } from "../report/types.ts";

export const SUITE_REPORT_SCHEMA = "crashpad.suite/v1";

/** The five supported check areas. */
export const AREAS = ["database", "api", "config", "permissions", "workflows"] as const;
export type Area = (typeof AREAS)[number];

export const AREA_TITLES: Record<Area, string> = {
  database: "Database compatibility",
  api: "API contracts",
  config: "Configuration and startup",
  permissions: "Permissions",
  workflows: "Application workflows",
};

/**
 * How completely an area was verified in this run.
 * - complete: everything the area supports for this project ran.
 * - partial: some of it ran; `missing` says exactly what did not and why.
 * - not-applicable: the project has nothing this area checks (e.g. no database).
 * - not-configured: the area applies but needs input that cannot be discovered.
 * - unavailable: it should have run but could not (infrastructure, setup failure).
 */
export type CoverageStatus = "complete" | "partial" | "not-applicable" | "not-configured" | "unavailable";

export interface AreaCoverage {
  area: Area;
  status: CoverageStatus;
  /** What ran, in words (e.g. "OpenAPI comparison (static)", "3 runtime scenarios"). */
  ran: string[];
  /** Exact missing requirements or reasons, one per item. */
  missing: string[];
}

/** One request/response, log excerpt, or diff that supports a finding. */
export interface Evidence {
  kind: "request" | "log" | "diff" | "sql" | "env" | "spec" | "note";
  side?: "baseline" | "candidate";
  label: string;
  detail: string;
}

export interface SideResult {
  status: "pass" | "fail" | "error" | "not-run" | "not-present" | "invalid";
  summary: string;
  durationMs?: number;
}

export interface Subject {
  /** Repo-relative file, when the finding is tied to one. */
  file?: string;
  line?: number;
  /** An HTTP operation such as `GET /orders/{id}`, an env variable, or a check id. */
  operation?: string;
}

export interface Finding {
  /** Stable id: `<area>:<check-or-rule id>`. */
  id: string;
  area: Area;
  /** Engine-level kind, e.g. `read`, `migration`, `spec`, `runtime`, `env`, `startup`, `permission`, `workflow`. */
  kind: string;
  title: string;
  classification: Classification;
  reason: string;
  message: string;
  isNew: boolean;
  subject: Subject;
  baseline: SideResult;
  candidate: SideResult;
  evidence: Evidence[];
  /** How to reproduce this finding locally. */
  reproduce?: string;
}

export interface SuiteReport {
  schemaVersion: typeof SUITE_REPORT_SCHEMA;
  tool: { name: "crashpad"; version: string };
  generatedAt: string;
  durationMs: number;
  project: string;
  base: { ref: string; commit: string };
  candidate: { label: string; commit: string | null };
  /** Where the effective configuration came from for the candidate side. */
  configSources: string[];
  exitCode: 0 | 1 | 2;
  status: "pass" | "fail" | "error";
  /** True when every applicable area ran completely. */
  complete: boolean;
  headline: string;
  coverage: AreaCoverage[];
  problems: Problem[];
  findings: Finding[];
  summary: Record<Classification, number> & { total: number };
  /** Full database-engine report, when the database area ran. */
  database?: Report;
}

export function emptySummary(): SuiteReport["summary"] {
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

/**
 * Exit code precedence, the same for every area:
 * problems → 2; any actionable finding → 1; anything undecided → 2;
 * no finding passed at all (nothing verified) → 2; otherwise 0. Partial coverage alone does not
 * fail a run, but the report says it is partial.
 */
export function suiteExitCode(r: Pick<SuiteReport, "problems" | "findings" | "coverage">, extra: { blockingHistory?: boolean; failedMigration?: boolean } = {}): 0 | 1 | 2 {
  if (r.problems.length) return 2;
  if (extra.failedMigration) return 1;
  if (r.findings.some((f) => ACTIONABLE.has(f.classification))) return 1;
  if (r.findings.some((f) => UNDECIDED.has(f.classification))) return 2;
  if (extra.blockingHistory) return 2;
  // A run in which nothing passed verified nothing; it must not look green.
  if (!r.findings.some((f) => f.classification === "pass")) return 2;
  return 0;
}
