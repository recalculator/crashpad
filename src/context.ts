import fs from "node:fs";
import path from "node:path";
import { git, repoRoot, resolveCommit } from "./git.ts";
import { normalizeRepoPath } from "./paths.ts";
import { FsSource, GitSource, type Source } from "./source.ts";
import { PgServer } from "./db/postgres.ts";
import type { RunInput } from "./runner.ts";

export const DEFAULT_DATABASE_URL = "postgres://localhost:5432/postgres";

export interface ContextOptions {
  cwd: string;
  base: string;
  head?: string;
  project?: string;
  databaseUrl?: string;
}

export interface RunContext {
  repoRoot: string;
  projectDir: string;
  input: RunInput;
  /** True when the candidate is the working tree (possibly with uncommitted edits). */
  workingTree: boolean;
}

export function databaseUrl(explicit?: string): string {
  return explicit ?? process.env.CRASHPAD_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

/** The project directory relative to the repo root: explicit, or inferred from cwd. */
export function projectDirFor(root: string, cwd: string, explicit?: string): string {
  if (explicit) return normalizeRepoPath(explicit, "project directory");
  // git reports the resolved root (e.g. /private/var on macOS), so resolve cwd too.
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(cwd));
  return normalizeRepoPath(rel || ".", "project directory");
}

export async function resolveContext(opts: ContextOptions): Promise<RunContext> {
  const root = await repoRoot(opts.cwd);
  const projectDir = projectDirFor(root, opts.cwd, opts.project);
  const baseCommit = await resolveCommit(root, opts.base);
  let candidate: { label: string; commit: string | null; source: Source };
  if (opts.head) {
    const commit = await resolveCommit(root, opts.head);
    candidate = { label: `\`${opts.head}\``, commit, source: new GitSource(root, commit, `git ${opts.head}`) };
  } else {
    const head = await git(root, ["rev-parse", "--verify", "HEAD"]).then((r) => r.stdout.trim()).catch(() => null);
    const dirty = (await git(root, ["status", "--porcelain", "--", projectDir])).stdout.trim().length > 0;
    candidate = { label: dirty ? "working tree (uncommitted changes)" : "HEAD (clean working tree)", commit: head, source: new FsSource(root) };
  }
  return {
    repoRoot: root,
    projectDir,
    workingTree: !opts.head,
    input: {
      projectDir,
      base: { ref: opts.base, commit: baseCommit, source: new GitSource(root, baseCommit, `git ${opts.base}`) },
      candidate,
      server: new PgServer(databaseUrl(opts.databaseUrl)),
    },
  };
}
