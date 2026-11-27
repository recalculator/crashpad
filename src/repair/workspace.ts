import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE } from "../config.ts";
import { git, gitOut } from "../git.ts";
import { listMigrations } from "../migrations.ts";
import { normalizeRepoPath, projectPath } from "../paths.ts";
import { GitSource } from "../source.ts";
import type { SuiteConfig } from "../suite/config.ts";

export interface Change {
  path: string;
  kind: "added" | "modified" | "deleted";
  symlink: boolean;
}

/**
 * An isolated clone of the repository, checked out (detached) at the exact
 * failing commit. Its `origin` remote is removed, so nothing done inside it can
 * reach the user's repository or GitHub.
 */
export class Workspace {
  readonly dir: string;
  readonly commit: string;
  private constructor(dir: string, commit: string) {
    this.dir = dir;
    this.commit = commit;
  }

  static async create(repoRoot: string, commit: string): Promise<Workspace> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "crashpad-repair-"));
    const dir = path.join(parent, "workspace");
    await git(repoRoot, ["clone", "--quiet", "--shared", "--no-checkout", repoRoot, dir]);
    await git(dir, ["checkout", "--quiet", "--detach", commit]);
    await git(dir, ["remote", "remove", "origin"]).catch(() => {});
    const head = await gitOut(dir, ["rev-parse", "HEAD"]);
    if (head !== commit) throw new Error(`workspace is at ${head}, expected ${commit}`);
    return new Workspace(dir, commit);
  }

  async changes(): Promise<Change[]> {
    await git(this.dir, ["add", "-A"]);
    const out = (await git(this.dir, ["diff", "--cached", "--name-status", "-z", "--no-renames", this.commit])).stdout.split("\0").filter(Boolean);
    const changes: Change[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const st = out[i]!;
      const p = out[i + 1]!;
      const kind = st.startsWith("A") ? "added" : st.startsWith("D") ? "deleted" : "modified";
      const lst = kind === "deleted" ? null : await fs.lstat(path.join(this.dir, p)).catch(() => null);
      changes.push({ path: p, kind, symlink: !!lst?.isSymbolicLink() });
    }
    return changes;
  }

  async diff(): Promise<string> {
    await git(this.dir, ["add", "-A"]);
    return (await git(this.dir, ["diff", "--cached", "--binary", "--no-renames", this.commit])).stdout;
  }

  /** Put files back exactly as they are at the failing commit (removing ones that did not exist). */
  async restore(paths: string[]): Promise<void> {
    for (const p of paths) {
      const existed = await git(this.dir, ["cat-file", "-e", `${this.commit}:${p}`]).then(() => true, () => false);
      if (existed) await git(this.dir, ["checkout", this.commit, "--", p]);
      else {
        await git(this.dir, ["rm", "-q", "--cached", "--ignore-unmatch", "--", p]).catch(() => {});
        await fs.rm(path.join(this.dir, p), { force: true });
      }
    }
  }

  async read(p: string): Promise<string | null> {
    return fs.readFile(path.join(this.dir, p), "utf8").catch(() => null);
  }

  async dispose(): Promise<void> {
    await fs.rm(path.dirname(this.dir), { recursive: true, force: true });
  }
}

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|specs|e2e|cypress|playwright)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_CONFIG = /(^|\/)(vitest|jest|playwright|cypress|mocha|ava)\.config\.[cm]?[jt]s$|(^|\/)\.mocharc/i;

export interface GuardrailContext {
  repoRoot: string;
  commit: string;
  projectDir: string;
  /** The candidate's effective configuration (from the original commit). */
  config: SuiteConfig;
}

/**
 * Why a changed path is off-limits for a repair, or null if it may be edited.
 * The rules protect what a fix is verified AGAINST: tests, assertions, check
 * manifests, Crashpad configuration, already-deployed migrations, CI, and the
 * scripts that run tests. Application source (and the candidate's own OpenAPI
 * document, which is compared against the immutable baseline) may be edited.
 */
export async function protectedPaths(ctx: GuardrailContext): Promise<(p: string) => string | null> {
  const fixed = new Map<string, string>();
  const at = (rel: string) => projectPath(ctx.projectDir, rel);
  fixed.set(at(CONFIG_FILE), "Crashpad configuration");
  const db = ctx.config.database;
  if (db?.checks) fixed.set(at(db.checks), "database check manifest (expectations)");
  if (db?.schema) fixed.set(at(db.schema), "database bootstrap schema");
  if (db?.seed) fixed.set(at(db.seed), "database sample data");
  if (ctx.config.http) fixed.set(at(ctx.config.http.checks), "runtime check manifest (expectations)");
  const existingMigrations = new Set<string>();
  if (db) {
    const src = new GitSource(ctx.repoRoot, ctx.commit);
    const mig = await listMigrations(src, { paths: { migrations: at(db.migrations) }, migrationFormat: db.migrationFormat });
    for (const m of mig) existingMigrations.add(m.path);
  }
  return (p: string) => {
    const n = normalizeRepoPath(p);
    if (fixed.has(n)) return fixed.get(n)!;
    if (existingMigrations.has(n)) return "existing migration (deployed databases already ran it)";
    if (n.startsWith(".github/") || n === ".gitlab-ci.yml" || n.startsWith(".circleci/")) return "CI configuration";
    if (n.startsWith(".crashpad/") || n.split("/").includes(".crashpad")) return "Crashpad data";
    if (TEST_PATH.test(n) || TEST_FILE.test(n) || TEST_CONFIG.test(n)) return "application test or test configuration";
    return null;
  };
}

export interface Violation {
  path: string;
  reason: string;
}

/** Guardrail violations in a workspace's changes. */
export async function violations(ws: Workspace, ctx: GuardrailContext): Promise<Violation[]> {
  const isProtected = await protectedPaths(ctx);
  const out: Violation[] = [];
  for (const c of await ws.changes()) {
    if (c.symlink) {
      out.push({ path: c.path, reason: "symbolic links may not be created or changed" });
      continue;
    }
    const why = isProtected(c.path);
    if (why) out.push({ path: c.path, reason: `${c.kind} ${why}` });
    if (path.posix.basename(c.path) === "package.json" && c.kind !== "added") {
      const before = await git(ctx.repoRoot, ["show", `${ctx.commit}:${c.path}`]).then((r) => r.stdout, () => null);
      const after = await ws.read(c.path);
      const scripts = (t: string | null) => {
        try {
          return JSON.stringify(t ? (JSON.parse(t).scripts ?? {}) : null);
        } catch {
          return "invalid";
        }
      };
      if (c.kind === "deleted" || scripts(before) !== scripts(after)) out.push({ path: c.path, reason: "package.json scripts (they run the tests and the app) may not change" });
    }
  }
  return out;
}
