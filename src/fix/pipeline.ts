import type { LoadedProject } from "../config.ts";
import type { Fixture } from "../fixtures.ts";
import { normalizeRepoPath } from "../paths.ts";
import { ACTIONABLE, type Report } from "../report/types.ts";
import { runChecks, type RunInput, type RunResult } from "../runner.ts";
import { OverlaySource, type Source } from "../source.ts";
import { VERSION } from "../version.ts";
import { sha256, unifiedPatch } from "./patch.ts";
import { listMigrations } from "../migrations.ts";
import { RenameProposer, type Proposal, type Proposer, type Refusal } from "./proposer.ts";
import { renderPrBody, prTitle } from "./pr-body.ts";
import type { ColumnRename } from "./renames.ts";
import type { RewriteChange } from "./rewriter.ts";

export type FixOutcome = "verified" | "partial" | "unsupported" | "not-needed";

export const FIX_PLAN_SCHEMA = "crashpad.fixplan/v1";

export interface FixPlan {
  schemaVersion: typeof FIX_PLAN_SCHEMA;
  tool: { name: "crashpad"; version: string };
  generatedAt: string;
  outcome: FixOutcome;
  /** Only verified plans may be published as a PR. */
  publishable: boolean;
  proposer: { name: string; kind: "deterministic" | "model" };
  project: string;
  base: { ref: string; commit: string };
  candidate: { label: string; commit: string | null };
  /** Hash of every input the verification depended on; publishing refuses if it changes. */
  inputsDigest: string;
  renames: ColumnRename[];
  edits: Array<{ path: string; beforeSha256: string; afterSha256: string; checkIds: string[]; changes: RewriteChange[] }>;
  refusals: Refusal[];
  original: { exitCode: number; headline: string; failing: string[] };
  verification: { exitCode: number; headline: string; stillFailing: string[] } | null;
  notes: string[];
}

export interface FixResult {
  outcome: FixOutcome;
  exitCode: 0 | 1 | 2;
  original: Report;
  verification: Report | null;
  proposal: Proposal | null;
  patch: string;
  plan: FixPlan;
  prTitle: string;
  prBody: string;
}

const notPassing = (r: Report) => r.checks.filter((c) => c.classification !== "pass" && c.classification !== "retired").map((c) => c.id);

/**
 * Digest of everything verification depended on: the base commit and every
 * candidate input file (config, manifest, schema, seed, migrations, fixture sources).
 */
export async function inputsDigest(baseCommit: string, project: LoadedProject, source: Source, fixtures: Map<string, Fixture>): Promise<string> {
  const paths = new Set<string>([project.configPath, project.manifestPath]);
  if (project.paths.schema) paths.add(project.paths.schema);
  if (project.paths.seed) paths.add(project.paths.seed);
  for (const m of await listMigrations(source, project)) paths.add(m.path);
  for (const f of fixtures.values()) if (f.origin.kind === "file") paths.add(f.origin.path);
  const entries: string[] = [`base:${baseCommit}`];
  for (const p of [...paths].sort()) {
    const content = await source.readFile(p);
    entries.push(`${p}:${content === null ? "missing" : sha256(content)}`);
  }
  return sha256(entries.join("\n"));
}

/**
 * Guardrails applied to every proposal, whatever produced it: only existing SQL
 * source files of failing read/write checks may change. Configuration, the check
 * manifest, migrations, schema, seed data, and assertion fixtures are never edited,
 * so a "fix" cannot work by deleting checks, weakening assertions, dropping
 * constraints, or changing sample data.
 */
export async function guardrailViolations(proposal: Proposal, project: LoadedProject, fixtures: Map<string, Fixture>, source: Source): Promise<string[]> {
  const v: string[] = [];
  const fixtureFiles = new Map<string, Fixture[]>();
  for (const f of fixtures.values()) if (f.origin.kind === "file") fixtureFiles.set(f.origin.path, [...(fixtureFiles.get(f.origin.path) ?? []), f]);
  const protectedPaths = new Set([project.configPath, project.manifestPath, project.paths.schema, project.paths.seed].filter(Boolean) as string[]);
  const seen = new Set<string>();
  for (const e of proposal.edits) {
    let p: string;
    try {
      p = normalizeRepoPath(e.path, "edit path");
    } catch (err) {
      v.push((err as Error).message);
      continue;
    }
    if (p !== e.path) v.push(`edit path is not normalized: ${e.path}`);
    if (seen.has(p)) v.push(`duplicate edit for ${p}`);
    seen.add(p);
    if (protectedPaths.has(p)) v.push(`refusing to edit protected input ${p}`);
    if (p === project.paths.migrations || p.startsWith(`${project.paths.migrations}/`)) v.push(`refusing to edit migration ${p}`);
    const users = fixtureFiles.get(p);
    if (!users) v.push(`refusing to edit ${p}: it is not the source file of any configured check`);
    else if (users.some((f) => f.def.category === "assertion")) v.push(`refusing to edit ${p}: assertion fixtures are never changed automatically`);
    const current = await source.readFile(p);
    if (current === null) v.push(`refusing to create new file ${p}`);
    else if (current !== e.before) v.push(`${p} changed since the proposal was made`);
    if (!p.endsWith(".sql")) v.push(`refusing to edit non-SQL file ${p}`);
  }
  return v;
}

export interface FixOptions {
  proposer?: Proposer;
  log?: (msg: string) => void;
}

export async function proposeAndVerify(input: RunInput, opts: FixOptions = {}): Promise<FixResult> {
  const proposer = opts.proposer ?? new RenameProposer();
  const log = opts.log ?? (() => {});
  log("running original checks");
  const original: RunResult = await runChecks(input);
  const report = original.report;
  const notes: string[] = [];
  let proposal: Proposal | null = null;
  let verification: Report | null = null;
  let outcome: FixOutcome;
  let exitCode: 0 | 1 | 2;

  const digest = original.candProject
    ? await inputsDigest(input.base.commit, original.candProject, input.candidate.source, original.candFixtures)
    : "";

  if (report.exitCode === 0) {
    outcome = "not-needed";
    exitCode = 0;
    notes.push("All checks already pass; no fix is needed.");
  } else if (report.problems.length || !original.candProject || !original.baselineCatalog || !original.migrations) {
    outcome = "unsupported";
    exitCode = 2;
    notes.push("The original run could not complete, so there is nothing reliable to fix against.");
  } else if (!report.checks.some((c) => ACTIONABLE.has(c.classification)) && !report.migrations.new.some((m) => m.status === "failed")) {
    outcome = "unsupported";
    exitCode = report.exitCode;
    notes.push("No actionable regressions: the run is undecided (baseline failures, invalid fixtures, inconclusive checks, or rewritten history).");
  } else if (report.migrations.new.some((m) => m.status === "failed")) {
    outcome = "unsupported";
    exitCode = report.exitCode;
    notes.push("A migration failed. Crashpad does not edit migrations; fix the migration first.");
  } else {
    proposal = await proposer.propose({
      original: report,
      candidateFixtures: original.candFixtures,
      addedMigrations: original.migrations.added,
      baselineCatalog: original.baselineCatalog,
    });
    const violations = await guardrailViolations(proposal, original.candProject, original.candFixtures, input.candidate.source);
    if (violations.length) {
      proposal.refusals.push(...violations.map((reason) => ({ path: null, checkIds: [], reason: `guardrail: ${reason}` })));
      proposal.edits = [];
    }
    if (proposal.edits.length === 0) {
      outcome = "unsupported";
      exitCode = report.exitCode;
      notes.push("No supported edits could be proposed.");
    } else {
      // Verification: the baseline side is untouched — the ORIGINAL baseline queries
      // and their original results are the contract. Only the candidate gets the patch.
      const overlay = new OverlaySource(input.candidate.source, new Map(proposal.edits.map((e) => [e.path, e.after])));
      log("re-running all checks with the proposed patch");
      const verified = await runChecks({ ...input, candidate: { label: `${input.candidate.label} + proposed patch`, commit: input.candidate.commit, source: overlay } });
      verification = verified.report;
      if (verification.base.commit !== report.base.commit) throw new Error("internal: verification used a different baseline");
      if (verification.exitCode === 0) {
        outcome = "verified";
        exitCode = 0;
      } else {
        outcome = "partial";
        exitCode = verification.exitCode;
        notes.push(`Verification did not pass: ${verification.headline}`);
      }
    }
  }

  const edits = proposal?.edits ?? [];
  const plan: FixPlan = {
    schemaVersion: FIX_PLAN_SCHEMA,
    tool: { name: "crashpad", version: VERSION },
    generatedAt: new Date().toISOString(),
    outcome,
    publishable: outcome === "verified",
    proposer: { name: proposer.name, kind: proposer.kind },
    project: input.projectDir,
    base: { ref: input.base.ref, commit: input.base.commit },
    candidate: { label: input.candidate.label, commit: input.candidate.commit },
    inputsDigest: digest,
    renames: proposal?.facts.renames ?? [],
    edits: edits.map((e) => ({ path: e.path, beforeSha256: sha256(e.before), afterSha256: sha256(e.after), checkIds: e.checkIds, changes: e.changes })),
    refusals: proposal?.refusals ?? [],
    original: { exitCode: report.exitCode, headline: report.headline, failing: notPassing(report) },
    verification: verification ? { exitCode: verification.exitCode, headline: verification.headline, stillFailing: notPassing(verification) } : null,
    notes,
  };
  const patch = unifiedPatch(edits);
  return {
    outcome,
    exitCode,
    original: report,
    verification,
    proposal,
    patch,
    plan,
    prTitle: prTitle(plan),
    prBody: renderPrBody(plan, report, verification, patch),
  };
}
