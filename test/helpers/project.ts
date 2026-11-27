import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { DEFAULT_DATABASE_URL } from "../../src/context.ts";
import { PgServer } from "../../src/db/postgres.ts";
import { runChecks, type RunResult } from "../../src/runner.ts";
import { proposeAndVerify, type FixOptions, type FixResult } from "../../src/fix/pipeline.ts";
import { FsSource, GitSource } from "../../src/source.ts";

/**
 * Integration tests use a REAL PostgreSQL server (CRASHPAD_DATABASE_URL or
 * DATABASE_URL, default postgres://localhost:5432/postgres) and REAL git
 * repositories in temp directories. Only GitHub HTTP calls are faked.
 */
export const DB_URL = process.env.CRASHPAD_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
export const server = new PgServer(DB_URL);

const GIT_ENV = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };

export function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

export function tempDir(prefix = "crashpad-test-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

export type Files = Record<string, string | null>;

export interface CheckSpec {
  id: string;
  category: "read" | "write" | "assertion";
  source?: string;
  sql?: string;
  params?: unknown[];
  ordered?: boolean;
  expectRows?: number;
  compareReturning?: boolean;
  ignoreColumns?: string[];
}

export function projectFiles(opts: {
  schema: string;
  seed?: string;
  checks: CheckSpec[];
  retired?: Array<{ id: string; reason: string }>;
  sql?: Record<string, string>;
  migrations?: Record<string, string>;
  limits?: Record<string, number>;
  rowSamples?: number;
}): Files {
  const files: Files = {
    "crashpad.config.json": JSON.stringify(
      {
        version: 1,
        schema: "db/schema.sql",
        ...(opts.seed !== undefined ? { seed: "db/seed.sql" } : {}),
        migrations: "db/migrations",
        checks: "checks.json",
        ...(opts.limits ? { limits: opts.limits } : {}),
        ...(opts.rowSamples !== undefined ? { report: { rowSamples: opts.rowSamples } } : {}),
      },
      null,
      2,
    ),
    "checks.json": JSON.stringify({ version: 1, checks: opts.checks, retired: opts.retired ?? [] }, null, 2),
    "db/schema.sql": opts.schema,
  };
  if (opts.seed !== undefined) files["db/seed.sql"] = opts.seed;
  for (const [k, v] of Object.entries(opts.sql ?? {})) files[`sql/${k}`] = v;
  for (const [k, v] of Object.entries(opts.migrations ?? {})) files[`db/migrations/${k}`] = v;
  return files;
}

export class TestRepo {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  static create(files: Files): TestRepo {
    const dir = tempDir();
    g(dir, "init", "-q", "-b", "main");
    const repo = new TestRepo(dir);
    repo.write(files);
    repo.commit("baseline");
    return repo;
  }
  write(files: Files): void {
    for (const [p, content] of Object.entries(files)) {
      const abs = path.join(this.dir, p);
      if (content === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    }
  }
  commit(message: string): string {
    g(this.dir, "add", "-A");
    g(this.dir, "commit", "-q", "--allow-empty", "-m", message);
    return g(this.dir, "rev-parse", "HEAD");
  }
  head(): string {
    return g(this.dir, "rev-parse", "HEAD");
  }
  read(p: string): string {
    return fs.readFileSync(path.join(this.dir, p), "utf8");
  }
}

function input(repo: TestRepo, base: string, head?: string) {
  const baseCommit = g(repo.dir, "rev-parse", `${base}^{commit}`);
  const candidate = head
    ? { label: head, commit: g(repo.dir, "rev-parse", `${head}^{commit}`), source: new GitSource(repo.dir, g(repo.dir, "rev-parse", `${head}^{commit}`)) }
    : { label: "working tree", commit: null, source: new FsSource(repo.dir) };
  return { projectDir: ".", base: { ref: base, commit: baseCommit, source: new GitSource(repo.dir, baseCommit) }, candidate, server };
}

/** Run checks with the baseline at `base` and the candidate at `head` (or the working tree). */
export async function check(repo: TestRepo, base = "main", head?: string): Promise<RunResult> {
  return runChecks(input(repo, base, head));
}

export async function fix(repo: TestRepo, base = "main", head?: string, opts: FixOptions = {}): Promise<FixResult> {
  return proposeAndVerify(input(repo, base, head), opts);
}

export const byId = (r: RunResult) => new Map(r.report.checks.map((c) => [c.id, c]));
