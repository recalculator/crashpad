import type { Column } from "../db/postgres.ts";
import type { ColumnDiff, RowDiff } from "../compare.ts";

export const REPORT_SCHEMA = "crashpad.report/v1";

/**
 * - pass: behaves the same as the baseline (or a new check that passes).
 * - regression: worked on the baseline, now errors (or a new check that fails).
 * - changed-result: runs, but output columns, rows, or affected-row counts changed.
 * - failed-assertion: an integrity assertion that held on the baseline is now false.
 * - baseline-failure: the check already failed before this change; it cannot vouch for the change.
 * - invalid-fixture: the check itself is malformed (parse error, wrong statement kind, bad assertion shape).
 * - inconclusive: the check could not be decided (row limit exceeded, timeout, deadline, infrastructure error).
 * - skipped: not run because a candidate migration failed.
 * - removed: the check disappeared from the candidate without being listed as retired.
 * - retired: the check was removed and acknowledged in the manifest's `retired` list.
 */
export type Classification =
  | "pass"
  | "regression"
  | "changed-result"
  | "failed-assertion"
  | "baseline-failure"
  | "invalid-fixture"
  | "inconclusive"
  | "skipped"
  | "removed"
  | "retired";

export const ACTIONABLE: ReadonlySet<Classification> = new Set(["regression", "changed-result", "failed-assertion", "removed"]);
export const UNDECIDED: ReadonlySet<Classification> = new Set(["baseline-failure", "invalid-fixture", "inconclusive", "skipped"]);

export interface SourceLocation {
  kind: "file" | "inline";
  path: string;
  line: number;
}

export interface ReportedError {
  code: string | null;
  message: string;
  /** Location of the error inside the fixture source, when PostgreSQL reports a position. */
  at?: { path: string; line: number; column: number };
}

export interface SideOutcome {
  status: "ok" | "error" | "invalid" | "not-present" | "not-run";
  error?: ReportedError;
  invalidReason?: string;
  columns?: Column[];
  rowCount?: number;
  affectedRows?: number | null;
  truncated?: boolean;
  assertion?: boolean | null;
  durationMs?: number;
}

export interface CheckFinding {
  id: string;
  category: "read" | "write" | "assertion";
  description?: string;
  classification: Classification;
  /** Short machine reason, e.g. `undefined_column`, `columns-changed`, `rows-changed`, `limit-exceeded`. */
  reason: string;
  message: string;
  isNew: boolean;
  fixtureChanged: boolean;
  source: SourceLocation | null;
  baselineSource: SourceLocation | null;
  baseline: SideOutcome;
  candidate: SideOutcome;
  columnDiff?: ColumnDiff;
  rowDiff?: Omit<RowDiff, "samples"> & { samples?: RowDiff["samples"] };
}

export interface MigrationEntry {
  file: string;
  status: "applied" | "failed" | "not-run";
  error?: ReportedError;
  durationMs?: number;
}

export interface HistoryIssue {
  kind: "edited-migration" | "removed-migration" | "out-of-order-migration" | "schema-edited" | "seed-changed";
  file: string;
  message: string;
  /** Blocking issues make the run undecided (exit 2) unless a regression is also found. */
  blocking: boolean;
}

export interface Problem {
  kind: "config" | "baseline" | "infrastructure" | "deadline";
  message: string;
}

export interface Report {
  schemaVersion: typeof REPORT_SCHEMA;
  tool: { name: "crashpad"; version: string };
  generatedAt: string;
  durationMs: number;
  project: string;
  base: { ref: string; commit: string };
  candidate: { label: string; commit: string | null };
  database: { serverVersionNum: number | null };
  exitCode: 0 | 1 | 2;
  status: "pass" | "fail" | "error";
  headline: string;
  problems: Problem[];
  migrations: { baseline: string[]; new: MigrationEntry[] };
  history: HistoryIssue[];
  checks: CheckFinding[];
  summary: Record<Classification, number> & { total: number };
}
