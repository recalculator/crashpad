import type { Catalog } from "../db/postgres.ts";
import type { Fixture } from "../fixtures.ts";
import type { MigrationFile } from "../migrations.ts";
import type { Report } from "../report/types.ts";
import { ACTIONABLE } from "../report/types.ts";
import { detectRenames, type ColumnRename } from "./renames.ts";
import { rewriteForRenames, type RewriteChange } from "./rewriter.ts";

export interface FileEdit {
  path: string;
  before: string;
  after: string;
  changes: RewriteChange[];
  /** Checks whose fixture source is this file. */
  checkIds: string[];
}

export interface Refusal {
  path: string | null;
  checkIds: string[];
  reason: string;
}

export interface Proposal {
  proposer: string;
  kind: "deterministic" | "model";
  edits: FileEdit[];
  refusals: Refusal[];
  /** Proposer-specific facts the plan should record (e.g. detected renames). */
  facts: { renames?: ColumnRename[] };
}

/** Everything a proposer may look at. Proposers return edits; they never write files. */
export interface ProposalContext {
  original: Report;
  candidateFixtures: Map<string, Fixture>;
  addedMigrations: MigrationFile[];
  baselineCatalog: Catalog;
}

/**
 * The boundary for fix generation. The shipped implementation is a deterministic,
 * rules-based rename fixer. A model-backed proposer could implement the same
 * interface; its output would go through exactly the same guardrails and
 * verification against the original baseline before anything is published.
 */
export interface Proposer {
  readonly name: string;
  readonly kind: "deterministic" | "model";
  propose(ctx: ProposalContext): Promise<Proposal>;
}

/** Rewrites SQL source files for explicit `RENAME COLUMN` migrations. No network, no API key. */
export class RenameProposer implements Proposer {
  readonly name = "rename-fixer";
  readonly kind = "deterministic" as const;

  async propose(ctx: ProposalContext): Promise<Proposal> {
    const { renames, refusals: renameRefusals } = detectRenames(ctx.addedMigrations);
    const refusals: Refusal[] = renameRefusals.map((reason) => ({ path: null, checkIds: [], reason }));
    const broken = ctx.original.checks.filter((c) => ACTIONABLE.has(c.classification) && c.classification !== "removed");
    if (renames.length === 0) {
      refusals.push({
        path: null,
        checkIds: broken.map((c) => c.id),
        reason: "no explicit RENAME COLUMN in the new migrations; the rename fixer has nothing to apply",
      });
      return { proposer: this.name, kind: this.kind, edits: [], refusals, facts: { renames } };
    }
    if (renameRefusals.length) return { proposer: this.name, kind: this.kind, edits: [], refusals, facts: { renames } };

    const byFile = new Map<string, string[]>();
    for (const c of broken) {
      const f = ctx.candidateFixtures.get(c.id);
      if (!f) continue;
      if (f.origin.kind !== "file") {
        refusals.push({ path: f.origin.path, checkIds: [c.id], reason: "inline SQL in the manifest is never edited automatically; move it to a .sql source file" });
        continue;
      }
      byFile.set(f.origin.path, [...(byFile.get(f.origin.path) ?? []), c.id]);
    }
    const edits: FileEdit[] = [];
    for (const [path, checkIds] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const fixture = ctx.candidateFixtures.get(checkIds[0]!)!;
      const r = rewriteForRenames(fixture.sql, renames, ctx.baselineCatalog);
      if (r.status === "changed") edits.push({ path, before: fixture.sql, after: r.text, changes: r.changes, checkIds });
      else if (r.status === "refused") refusals.push({ path, checkIds, reason: r.reason });
      else refusals.push({ path, checkIds, reason: "no references to a renamed column; this failure has a different cause" });
    }
    return { proposer: this.name, kind: this.kind, edits, refusals, facts: { renames } };
  }
}
