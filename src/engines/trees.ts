import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../suite/config.ts";
import { materialize, runCommand, tempWorkdir, type CommandResult } from "./app.ts";
import { buildTestEnv } from "./env.ts";

/**
 * One exported, dependency-installed copy of each version's code per suite run.
 * The database area (ORM schema export), the runtime checks, and the project's own
 * commands all use the same copy, so each version is exported and installed once.
 */

export type Which = "baseline" | "candidate";

export interface CodeTree {
  which: Which;
  /** Root of the exported repository copy. */
  dir: string;
  /** The project directory inside it. */
  projectDir: string;
  /** Where the app's commands run (project dir + app.root). */
  appDir: string;
  /** Export or install failure; nothing else can run in this tree. */
  problem?: string;
  /** The build command's result, once something ran it. */
  build?: CommandResult;
}

function lastLines(text: string, n: number): string {
  return text.trimEnd().split("\n").slice(-n).join("\n");
}

export class CodeTrees {
  private trees = new Map<Which, Promise<CodeTree>>();
  private dirs: string[] = [];

  private o: { keep?: boolean; signal?: AbortSignal; log?: (m: string) => void };

  constructor(o: { keep?: boolean; signal?: AbortSignal; log?: (m: string) => void } = {}) {
    this.o = o;
  }

  get(which: Which, code: { root: string; commit: string | null }, projectDir: string, app: AppConfig): Promise<CodeTree> {
    let t = this.trees.get(which);
    if (!t) {
      t = this.prepare(which, code, projectDir, app);
      this.trees.set(which, t);
    }
    return t;
  }

  private async prepare(which: Which, code: { root: string; commit: string | null }, projectDir: string, app: AppConfig): Promise<CodeTree> {
    const log = this.o.log ?? (() => {});
    const dir = await tempWorkdir(which);
    this.dirs.push(dir);
    const proj = path.join(dir, projectDir === "." ? "" : projectDir);
    const tree: CodeTree = { which, dir, projectDir: proj, appDir: path.join(proj, app.root === "." ? "" : app.root) };
    try {
      log(`${which}: exporting ${code.commit ? code.commit.slice(0, 12) : "working tree"}`);
      await materialize(code.root, code.commit, dir);
    } catch (err) {
      tree.problem = `could not export the ${which} code: ${(err as Error).message}`;
      return tree;
    }
    if (app.install) {
      log(`${which}: ${app.install.join(" ")}`);
      const r = await runCommand(app.install, { cwd: tree.appDir, env: buildTestEnv({ schema: null, useExampleValues: false, explicit: {}, generated: {} }).env, timeoutMs: app.installTimeoutMs, ...(this.o.signal ? { signal: this.o.signal } : {}) });
      if (!r.ok) tree.problem = `dependency install failed for the ${which} (\`${app.install.join(" ")}\`${r.timedOut ? `, timed out after ${app.installTimeoutMs} ms` : `, exit ${r.code}`}):\n${lastLines(r.output, 20)}`;
    }
    return tree;
  }

  async dispose(): Promise<void> {
    if (this.o.keep) return;
    for (const d of this.dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
}
