import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { UsageError, type Values } from "../cli.ts";
import { databaseUrl, projectDirFor } from "../context.ts";
import { loadCompanionConfig, ServiceClient } from "../companion/client.ts";
import { PgServer, redactUrl } from "../db/postgres.ts";
import { discoverer, DISCOVERY_RULES_VERSION } from "../discovery/index.ts";
import { crashpadHome, keyFor, loadSettings, normalizeRemote, repoDir, repoIdentity, saveSettings, setPath, storedScenariosPath } from "../discovery/store.ts";
import { storedScenarios } from "../discovery/index.ts";
import { HttpManifestSchema } from "../engines/http.ts";
import { ConfigError, formatConfigError, parseJson } from "../config.ts";
import { git, gitOut, repoRoot } from "../git.ts";
import { ClaudeCodeAgent } from "../repair/claude.ts";
import { FsSource, GitSource, type Source } from "../source.ts";
import { mergeLayers, parseEffective, readConfigFileLayer } from "../suite/config.ts";
import type { Discovery } from "../suite/runner.ts";
import { AREAS, AREA_TITLES, type Area } from "../suite/types.ts";
import { VERSION } from "../version.ts";

type Readiness = "ready" | "partial" | "needs input" | "not detected";

export interface RepoOnboarding {
  repo: string;
  commit: string | null;
  discoveredAt: string;
  rulesVersion: number;
  configSources: string[];
  areas: Record<Area, { status: Readiness; found: string[]; missing: string[] }>;
  /** The project's own build/typecheck/test commands Crashpad will run on both versions (reported separately). */
  commands: { found: string[]; missing: string[] };
  configError?: string;
}

/** What discovery (plus stored settings and an optional repo file) gives each area. */
export async function onboard(source: Source, projectDir: string, repo: string, commit: string | null, settings?: Record<string, unknown>, stored?: { path: string; checks: number } | null): Promise<RepoOnboarding> {
  const d: Discovery = await discoverer({ cache: true })(source, projectDir);
  const file = await readConfigFileLayer(source, projectDir).catch(() => null);
  const layers = [d.layer, ...(settings ? [settings] : []), ...(file ? [file.layer] : [])];
  const raw = mergeLayers(...layers);
  const sources = ["discovered", ...(settings ? ["Crashpad settings"] : []), ...(file ? [file.path] : [])];
  let configError: string | undefined;
  try {
    parseEffective(raw, "effective configuration");
  } catch (err) {
    configError = (err as Error).message;
  }
  const has = (k: string) => k.split(".").reduce<unknown>((o, x) => (o && typeof o === "object" ? (o as Record<string, unknown>)[x] : undefined), raw) !== undefined;
  const overridden = (k?: string) => (k === "http.checks" && !!stored) || (!!k && layers.length > 1) && k.split(".").reduce<unknown>((o, x) => (o && typeof o === "object" ? (o as Record<string, unknown>)[x] : undefined), mergeLayers(...layers.slice(1))) !== undefined;
  const missingFor = (a: Area) => d.missing.filter((m) => m.area === a && !overridden(m.key)).map((m) => m.message);
  const areas = {} as RepoOnboarding["areas"];
  const status = (area: Area, ok: boolean, partialOk: boolean): Readiness => {
    const miss = missingFor(area);
    if (ok && !miss.length) return "ready";
    if (ok || partialOk) return "partial";
    return miss.length ? "needs input" : "not detected";
  };
  const ormOnly = !has("database.migrations") && has("orm.schema");
  areas.database = {
    status: status("database", has("database.migrations") && has("database.checks"), has("database.migrations") || has("orm.schema")),
    found: d.facts.filter((f) => /migrations|seed|check manifest|PostgreSQL|ORM schema/i.test(f)),
    // Schema compatibility is never complete database coverage; say what it leaves out up front.
    missing: [...missingFor("database"), ...(ormOnly ? ["schema compatibility only: no migration sequence, synthetic sample rows, and the application's queries are not exercised"] : [])],
  };
  areas.api = { status: status("api", has("api.openapi") && has("app.start"), has("api.openapi")), found: d.facts.filter((f) => /OpenAPI/i.test(f)), missing: [...missingFor("api"), ...(has("api.openapi") && !has("app.start") ? ["runtime contract checks need an application start command (app.start)"] : [])] };
  areas.config = { status: status("config", has("app.start") && has("app.envSchema"), has("app.start")), found: d.facts.filter((f) => /start script|build script|environment (schema|declared)|readiness|package.json|lockfile|port variable|typecheck script|test script/i.test(f)), missing: missingFor("config") };
  const scenarios = has("http.checks") || !!stored;
  const storedFact = stored ? [`${stored.checks} runtime scenario(s) stored in Crashpad's storage (${stored.path}), not in the repository`] : [];
  for (const a of ["permissions", "workflows"] as const) areas[a] = { status: status(a, scenarios && has("app.start"), false), found: [...d.facts.filter((f) => /runtime check manifest/i.test(f)), ...storedFact], missing: missingFor(a) };
  const get = (k: string) => k.split(".").reduce<unknown>((o, x) => (o && typeof o === "object" ? (o as Record<string, unknown>)[x] : undefined), raw);
  const build = get("app.build") as string[] | undefined;
  const tests = (get("tests") as string[][] | undefined) ?? [];
  const commands = {
    found: [...(build ? [`build: ${build.join(" ")}`] : []), ...tests.map((t) => `test: ${t.join(" ")}`)],
    missing: has("app") ? [...(build ? [] : ['no "build" script']), ...(tests.length ? [] : ['no "test" or "typecheck" script'])] : [],
  };
  return { repo, commit, discoveredAt: new Date().toISOString(), rulesVersion: DISCOVERY_RULES_VERSION, configSources: sources, areas, commands, ...(configError ? { configError } : {}) };
}

export function renderOnboarding(o: RepoOnboarding): string {
  const icon: Record<Readiness, string> = { ready: "✓", partial: "◐", "needs input": "○", "not detected": "—" };
  const lines = [`${o.repo}${o.commit ? ` @ ${o.commit.slice(0, 12)}` : " (working tree)"}  [${o.configSources.join(" + ")}]`];
  for (const a of AREAS) {
    const x = o.areas[a];
    lines.push(`  ${icon[x.status]} ${AREA_TITLES[a].padEnd(26)} ${x.status}`);
    for (const f of x.found) lines.push(`      found: ${f}`);
    for (const m of x.missing) lines.push(`      missing: ${m}`);
  }
  if (o.commands.found.length || o.commands.missing.length) {
    lines.push("  Project commands (the project's own scripts; run on both versions and reported separately, not as Crashpad checks):");
    for (const f of o.commands.found) lines.push(`      ${f}`);
    for (const m of o.commands.missing) lines.push(`      none: ${m}`);
  }
  if (o.configError) lines.push(`  ✗ configuration error: ${o.configError}`);
  const ready = AREAS.filter((a) => o.areas[a].status === "ready").length;
  lines.push(`  ${ready} of ${AREAS.length} areas fully configured; others run partially or need the input listed above. Nothing was written to the repository.`);
  return lines.join("\n");
}

export async function cmdDiscover(v: Values, cwd: string): Promise<number> {
  const root = await repoRoot(cwd);
  const projectDir = projectDirFor(root, cwd, v.project);
  const { id, key } = await repoIdentity(root);
  const settings = (await loadSettings(key))?.config;
  const st = await storedScenarios(key);
  const o = await onboard(new FsSource(root), projectDir, id, null, settings, st ? { path: st.path, checks: st.manifest.checks.length } : null);
  process.stdout.write(v.format === "json" ? JSON.stringify(o, null, 2) + "\n" : renderOnboarding(o) + "\n");
  return o.configError ? 2 : 0;
}

function parseValue(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function cmdSettings(v: Values, cwd: string): Promise<number> {
  let id: string;
  let key: string;
  if (v.repo) {
    id = `github.com/${v.repo.toLowerCase()}`;
    key = keyFor(id);
  } else ({ id, key } = await repoIdentity(await repoRoot(cwd)));
  const current = (await loadSettings(key)) ?? { repo: id, updatedAt: new Date().toISOString(), config: {} };
  if (v.set?.length || v.unset?.length) {
    for (const kv of v.set ?? []) {
      const i = kv.indexOf("=");
      if (i <= 0) throw new UsageError(`--set expects key=value (got ${kv})`);
      setPath(current.config, kv.slice(0, i), parseValue(kv.slice(i + 1)));
    }
    for (const k of v.unset ?? []) setPath(current.config, k, undefined);
    parseEffective(mergeLayers(current.config), "Crashpad settings"); // validate before saving
    current.updatedAt = new Date().toISOString();
    await saveSettings(key, current);
  }
  process.stdout.write(`${id} (${path.join(repoDir(key), "settings.json")})\n${JSON.stringify(current.config, null, 2)}\n`);
  return 0;
}

/**
 * Runtime scenarios kept in Crashpad's storage instead of the repository, for projects
 * whose owners do not want a Crashpad file committed. Same format as crashpad.http.json.
 */
export async function cmdScenarios(v: Values, cwd: string): Promise<number> {
  let id: string;
  let key: string;
  if (v.repo) {
    id = `github.com/${v.repo.toLowerCase()}`;
    key = keyFor(id);
  } else ({ id, key } = await repoIdentity(await repoRoot(cwd)));
  const dest = storedScenariosPath(key);
  if (v.import && v.remove) throw new UsageError("use either --import or --remove");
  if (v.import) {
    const src = path.resolve(cwd, v.import);
    const raw = await fs.readFile(src, "utf8");
    const m = HttpManifestSchema.safeParse(parseJson(raw, src));
    if (!m.success) throw new ConfigError(`${src}: ${formatConfigError(m.error)}`);
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    // Scenarios can hold test credentials for test identities: owner-only.
    const tmp = `${dest}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(m.data, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmp, dest);
  } else if (v.remove) {
    await fs.rm(dest, { force: true });
    process.stdout.write(`${id}: stored scenarios removed\n`);
    return 0;
  }
  const stored = await storedScenarios(key);
  if (!stored) {
    process.stdout.write(`${id}: no stored scenarios (${dest}). Import a crashpad.http.json-format file with: crashpad scenarios --import <file>\n`);
    return 0;
  }
  const by = (a: string) => stored.manifest.checks.filter((c) => c.area === a).length;
  process.stdout.write(
    `${id}: ${stored.manifest.checks.length} scenario(s) stored in ${stored.path}\n` +
      `  api ${by("api")}, permissions ${by("permissions")}, workflows ${by("workflows")}; identities: ${Object.keys(stored.manifest.identities).join(", ") || "none"}\n` +
      "  Used when the repository has no crashpad.http.json. Not versioned with the code: the same expectations apply to the baseline and the candidate.\n",
  );
  return 0;
}

function versionOf(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/**
 * One-time onboarding: prerequisites, Claude Code (optional), GitHub connection,
 * then discovery for every repository the GitHub App can see (and any local
 * directories given with --repo-dir). Results are stored in Crashpad's storage.
 */
export async function cmdSetup(v: Values, cwd: string): Promise<number> {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  out(`Crashpad ${VERSION} setup (storage: ${crashpadHome()})\n`);
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  out(`${major! > 22 || (major === 22 && minor! >= 18) ? "✓" : "✗"} Node.js ${process.versions.node} (needs 22.18 or later)`);
  const gitV = versionOf("git", ["--version"]);
  out(`${gitV ? "✓" : "✗"} ${gitV ?? "git not found"}`);
  const url = databaseUrl(v["database-url"]);
  try {
    const n = await new PgServer(url).serverVersion();
    out(`✓ PostgreSQL ${Math.floor(n / 10000)} at ${redactUrl(url)} (database checks can create throwaway databases)`);
  } catch (err) {
    out(`○ PostgreSQL not reachable at ${redactUrl(url)}: ${(err as Error).message}\n    Database and database-backed runtime checks need it (set CRASHPAD_DATABASE_URL). Other checks still run.`);
  }
  const claude = await new ClaudeCodeAgent().status();
  out(claude.ready ? `✓ ${claude.message}: repairs can use your Claude Code (only when you request one or enable a repair policy)` : `○ Claude Code: ${claude.message}\n    Checks work without it; only Claude repairs are unavailable.`);

  const comp = await loadCompanionConfig();
  const repos: Array<{ label: string; key: string; source: Source; projectDir: string; commit: string | null; local?: boolean; settings?: Record<string, unknown> }> = [];
  if (!comp) out("○ GitHub: not connected. Install the Crashpad GitHub App, then run: crashpad connect --service <url>");
  else {
    const client = new ServiceClient(comp.service, comp.token);
    try {
      const list = (await client.repos()) ?? [];
      out(`✓ GitHub: connected as ${comp.login} via ${comp.service}; companion "${comp.name}"; repairs ${comp.repair.enabled ? "on" : "off"} on this computer`);
      out(`  ${list.length} repositor${list.length === 1 ? "y" : "ies"} in the App installation (${[...new Set(list.map((r) => r.selection))].join(", ") || "none"} selection)`);
      for (const r of list) {
        try {
          const tok = await client.call<{ token: string; cloneUrl: string }>("POST", "/api/companion/token", { repo: r.repo });
          const key = keyFor(normalizeRemote(tok!.cloneUrl));
          const dir = path.join(repoDir(key), "git");
          if (!(await fs.stat(path.join(dir, ".git")).catch(() => null))) {
            await fs.mkdir(dir, { recursive: true });
            await git(dir, ["init", "-q"]);
            await git(dir, ["remote", "add", "origin", tok!.cloneUrl]);
          }
          const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
          await git(dir, ["fetch", "--quiet", "--no-tags", "origin", "HEAD"], { env: { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "http.extraHeader", [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${Buffer.from(`x-access-token:${tok!.token}`).toString("base64")}` } });
          const commit = await gitOut(dir, ["rev-parse", "FETCH_HEAD"]);
          const settings = (await loadSettings(key))?.config;
          repos.push({ label: r.repo, key, source: new GitSource(dir, commit), projectDir: ".", commit, ...(settings ? { settings } : {}) });
        } catch (err) {
          out(`  ✗ ${r.repo}: could not fetch for discovery: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      out(`✗ GitHub: the Crashpad service at ${comp.service} did not respond: ${(err as Error).message}`);
    }
  }
  for (const d of v["repo-dir"] ?? []) {
    const root = await repoRoot(path.resolve(cwd, d));
    const { id, key } = await repoIdentity(root);
    const settings = (await loadSettings(key))?.config;
    // Show the directory that was analyzed; settings are shared by every clone of the same origin.
    const origin = await gitOut(root, ["config", "--get", "remote.origin.url"]).catch(() => "");
    repos.push({ label: id.startsWith("local:") || !origin ? root : `${root} (settings shared with origin ${origin.trim()})`, key, source: new FsSource(root), projectDir: ".", commit: null, local: true, ...(settings ? { settings } : {}) });
  }
  if (!repos.length) {
    out("\nNo repositories to discover yet (connect GitHub, or pass --repo-dir <path>).");
    return 0;
  }
  out("\nRepositories (Node.js / TypeScript / PostgreSQL discovery):\n");
  for (const r of repos) {
    const st = await storedScenarios(r.key).catch((err) => {
      out(`  ✗ ${r.label}: stored scenarios are invalid: ${(err as Error).message}`);
      return null;
    });
    const o = await onboard(r.source, r.projectDir, r.label, r.commit, r.settings, st ? { path: st.path, checks: st.manifest.checks.length } : null);
    await fs.mkdir(repoDir(r.key), { recursive: true });
    await fs.writeFile(path.join(repoDir(r.key), "onboarding.json"), JSON.stringify(o, null, 2) + "\n", { mode: 0o600 });
    out(renderOnboarding(o) + "\n");
  }
  out(`Provide missing values without touching the repository: ${repos.some((r) => r.local) ? "inside a local repository, crashpad settings --set app.env.NAME=test-value" : ""}${repos.some((r) => r.local) && repos.some((r) => !r.local) ? "; for an App repository, " : ""}${repos.some((r) => !r.local) ? "crashpad settings --repo owner/name --set app.env.NAME=test-value" : ""}`);
  return 0;
}
