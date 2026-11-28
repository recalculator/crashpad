import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitOut } from "../git.ts";

/**
 * Crashpad's own storage (default `~/.crashpad`, override with CRASHPAD_HOME).
 * Generated onboarding settings live here, not in the repositories:
 *
 *   repos/<repo-key>/settings.json     user-provided overrides (a config layer)
 *   repos/<repo-key>/crashpad.http.json  runtime scenarios kept outside the repository (optional)
 *   repos/<repo-key>/discovery/<tree>.json  cached discovery for one Git tree
 *
 * A discovery cache entry is only reused for the identical Git tree, the same
 * discovery rules version, and the same Crashpad version, so a commit or tooling
 * change always re-runs discovery.
 */

export function crashpadHome(): string {
  return process.env.CRASHPAD_HOME ?? path.join(os.homedir(), ".crashpad");
}

/** Normalize a Git remote URL to `host/owner/name`. */
export function normalizeRemote(url: string): string {
  const u = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const ssh = u.match(/^[\w.-]+@([^:]+):(.+)$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
  try {
    const p = new URL(u);
    return `${p.host}${p.pathname}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/** Stable repository identity: the `origin` remote when there is one, else the repository path. */
export async function repoIdentity(repoRoot: string): Promise<{ id: string; key: string }> {
  const remote = await gitOut(repoRoot, ["config", "--get", "remote.origin.url"]).catch(() => "");
  const id = remote ? normalizeRemote(remote) : `local:${await fs.realpath(repoRoot)}`;
  return { id, key: keyFor(id) };
}

/** Storage key for a repository identity (stable, filesystem-safe). */
export function keyFor(id: string): string {
  const slug = id.replace(/^local:/, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-60);
  return `${slug}-${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
}

export function repoDir(key: string): string {
  return path.join(crashpadHome(), "repos", key);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface RepoSettings {
  repo: string;
  updatedAt: string;
  /** A configuration layer applied over discovery (and under a repo's own crashpad.config.json). */
  config: Record<string, unknown>;
}

export async function loadSettings(key: string): Promise<RepoSettings | null> {
  return readJson<RepoSettings>(path.join(repoDir(key), "settings.json"));
}

export async function saveSettings(key: string, s: RepoSettings): Promise<void> {
  await writeJsonAtomic(path.join(repoDir(key), "settings.json"), s);
}

/** Where a repository's externally stored runtime scenarios live (same format as crashpad.http.json). */
export function storedScenariosPath(key: string): string {
  return path.join(repoDir(key), "crashpad.http.json");
}

export interface CachedDiscovery<T> {
  tree: string;
  rulesVersion: number;
  toolVersion: string;
  discoveredAt: string;
  result: T;
}

export async function readDiscoveryCache<T>(key: string, tree: string, rulesVersion: number, toolVersion: string): Promise<T | null> {
  const hit = await readJson<CachedDiscovery<T>>(path.join(repoDir(key), "discovery", `${tree}.json`));
  if (!hit || hit.tree !== tree || hit.rulesVersion !== rulesVersion || hit.toolVersion !== toolVersion) return null;
  return hit.result;
}

export async function writeDiscoveryCache<T>(key: string, tree: string, rulesVersion: number, toolVersion: string, result: T): Promise<void> {
  await writeJsonAtomic(path.join(repoDir(key), "discovery", `${tree}.json`), { tree, rulesVersion, toolVersion, discoveredAt: new Date().toISOString(), result } satisfies CachedDiscovery<T>);
}

/** Set `a.b.c` in a nested object; `undefined` deletes. */
export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}
