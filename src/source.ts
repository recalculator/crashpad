import fs from "node:fs/promises";
import path from "node:path";
import { git, GitError } from "./git.ts";
import { normalizeRepoPath, PathError } from "./paths.ts";

/**
 * A read-only view of repository files at some state: the working tree, a Git
 * commit, or another source with proposed edits overlaid. All paths are
 * repository-relative POSIX paths.
 */
export interface Source {
  readonly label: string;
  /** Returns null when the file does not exist. */
  readFile(rel: string): Promise<string | null>;
  /** File names (not subdirectories) directly inside `rel`, or null if it is not a directory. */
  listFiles(rel: string): Promise<string[] | null>;
  /** Subdirectory names directly inside `rel`, or null if it is not a directory. */
  listDirs(rel: string): Promise<string[] | null>;
}

/** Files on disk under a root directory. Symlinks that resolve outside the root are refused. */
export class FsSource implements Source {
  readonly label: string;
  private realRoot: Promise<string>;
  readonly root: string;
  constructor(root: string, label = "working tree") {
    this.root = root;
    this.label = label;
    this.realRoot = fs.realpath(root);
  }

  private async resolve(rel: string): Promise<string | null> {
    const norm = normalizeRepoPath(rel);
    const root = await this.realRoot;
    const abs = path.join(root, norm);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new PathError(`path resolves outside the repository via a symlink: ${rel}`);
    }
    return real;
  }

  async readFile(rel: string): Promise<string | null> {
    const real = await this.resolve(rel);
    if (!real) return null;
    const stat = await fs.stat(real);
    if (!stat.isFile()) return null;
    return fs.readFile(real, "utf8");
  }

  async listFiles(rel: string): Promise<string[] | null> {
    const real = await this.resolve(rel);
    if (!real) return null;
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) return null;
    const entries = await fs.readdir(real, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  }

  async listDirs(rel: string): Promise<string[] | null> {
    const real = await this.resolve(rel);
    if (!real) return null;
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) return null;
    const entries = await fs.readdir(real, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name !== ".git").map((e) => e.name).sort();
  }
}

/** Files as committed at a specific Git commit. Symlinks and submodules are refused. */
export class GitSource implements Source {
  readonly label: string;
  readonly repo: string;
  readonly commit: string;
  constructor(repo: string, commit: string, label?: string) {
    this.repo = repo;
    this.commit = commit;
    this.label = label ?? `git ${commit.slice(0, 12)}`;
  }

  private async entry(rel: string): Promise<{ mode: string; type: string; oid: string } | null> {
    const norm = normalizeRepoPath(rel);
    if (norm === ".") return { mode: "040000", type: "tree", oid: `${this.commit}^{tree}` };
    const { stdout } = await git(this.repo, ["ls-tree", "-z", "--full-tree", this.commit, "--", norm]);
    const line = stdout.split("\0").find((l) => l.length > 0);
    if (!line) return null;
    const m = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s);
    if (!m || m[4] !== norm) return null;
    return { mode: m[1]!, type: m[2]!, oid: m[3]! };
  }

  async readFile(rel: string): Promise<string | null> {
    const e = await this.entry(rel);
    if (!e) return null;
    if (e.mode === "120000") throw new PathError(`refusing to follow symlink in git tree: ${rel}`);
    if (e.type !== "blob") return null;
    const { stdout } = await git(this.repo, ["cat-file", "blob", e.oid]);
    return stdout;
  }

  private async tree(rel: string): Promise<RegExpMatchArray[] | null> {
    const norm = normalizeRepoPath(rel);
    const e = await this.entry(norm);
    if (!e || e.type !== "tree") return null;
    const target = norm === "." ? this.commit : `${this.commit}:${norm}`;
    let stdout: string;
    try {
      ({ stdout } = await git(this.repo, ["ls-tree", "-z", target]));
    } catch (err) {
      if (err instanceof GitError) return null;
      throw err;
    }
    return stdout
      .split("\0")
      .filter((l) => l.length > 0)
      .map((l) => l.match(/^(\d+) (\w+) [0-9a-f]+\t(.*)$/s))
      .filter((m): m is RegExpMatchArray => !!m);
  }

  async listFiles(rel: string): Promise<string[] | null> {
    const t = await this.tree(rel);
    if (!t) return null;
    return t.filter((m) => m[2] === "blob" && m[1] !== "120000").map((m) => m[3]!).sort();
  }

  async listDirs(rel: string): Promise<string[] | null> {
    const t = await this.tree(rel);
    if (!t) return null;
    return t.filter((m) => m[2] === "tree").map((m) => m[3]!).sort();
  }
}

/** Another source with some files replaced, e.g. a proposed patch under verification. */
export class OverlaySource implements Source {
  readonly label: string;
  private files: Map<string, string>;
  readonly base: Source;
  constructor(base: Source, overrides: Map<string, string>, label?: string) {
    this.base = base;
    this.files = new Map([...overrides].map(([k, v]) => [normalizeRepoPath(k), v]));
    this.label = label ?? `${base.label} + proposed patch`;
  }
  async readFile(rel: string): Promise<string | null> {
    const norm = normalizeRepoPath(rel);
    const hit = this.files.get(norm);
    return hit !== undefined ? hit : this.base.readFile(norm);
  }
  async listFiles(rel: string): Promise<string[] | null> {
    // Overlays only replace existing files; they never add or remove entries.
    return this.base.listFiles(rel);
  }
  async listDirs(rel: string): Promise<string[] | null> {
    return this.base.listDirs(rel);
  }
}
