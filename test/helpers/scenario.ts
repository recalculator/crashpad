import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
export const STOREFRONT = path.join(FIXTURES, "storefront");
export const SCENARIOS = path.join(FIXTURES, "scenarios");

export interface Scenario {
  name: string;
  dir: string;
  title: string;
  description: string;
  mode: "check" | "fix";
  expectedExit: number;
  addChecks?: unknown[];
  replace?: Array<{ file: string; find: string; with: string }>;
  expect?: Record<string, string>;
  expectNew?: string[];
  expectErrorCode?: Record<string, string>;
  expectOutcome?: string;
  expectEdited?: string[];
}

export function loadScenarios(): Scenario[] {
  return fs
    .readdirSync(SCENARIOS)
    .filter((d) => fs.existsSync(path.join(SCENARIOS, d, "scenario.json")))
    .sort()
    .map((name) => ({ name, dir: path.join(SCENARIOS, name), ...JSON.parse(fs.readFileSync(path.join(SCENARIOS, name, "scenario.json"), "utf8")) }));
}

export function sh(cwd: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Crashpad Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Crashpad Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

function copyDir(src: string, dst: string): void {
  fs.cpSync(src, dst, { recursive: true });
}

/**
 * Build a real Git repository for a scenario: `main` holds the unchanged storefront
 * fixture (the baseline), and branch `change` holds the scenario's edits on top of it.
 */
export function buildScenarioRepo(s: Scenario, parent = fs.mkdtempSync(path.join(os.tmpdir(), `crashpad-scenario-${s.name}-`))): string {
  const repo = path.join(parent, "repo");
  copyDir(STOREFRONT, repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), "crashpad-report/\ncrashpad-fix/\n");
  sh(repo, "git", ["init", "-q", "-b", "main"]);
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "Baseline storefront"], GIT_ENV);
  sh(repo, "git", ["switch", "-q", "-c", "change"]);
  const files = path.join(s.dir, "files");
  if (fs.existsSync(files)) copyDir(files, repo);
  for (const r of s.replace ?? []) {
    const p = path.join(repo, r.file);
    const text = fs.readFileSync(p, "utf8");
    if (!text.includes(r.find)) throw new Error(`${s.name}: ${r.file} does not contain ${JSON.stringify(r.find)}`);
    fs.writeFileSync(p, text.replace(r.find, r.with));
  }
  if (s.addChecks?.length) {
    const mp = path.join(repo, "crashpad.checks.json");
    const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
    manifest.checks.push(...s.addChecks);
    fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + "\n");
  }
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", `Change: ${s.title}`], GIT_ENV);
  return repo;
}
