import fs from "node:fs/promises";
import path from "node:path";
import { materialize, runCommand, tempWorkdir } from "../engines/app.ts";
import { buildTestEnv, loadEnvSchema } from "../engines/env.ts";
import { FsSource, GitSource } from "../source.ts";
import type { SuiteConfig } from "../suite/config.ts";

export interface TestCommandResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface AppTestsResult {
  ran: boolean;
  /** Install/build problems that stopped the tests from running. */
  problem?: string;
  results: TestCommandResult[];
}

/**
 * Run the application's own test commands (configured or discovered) against one
 * version of the code, in a fresh export with its dependencies installed. Tests get
 * the same sanitized test environment as the app (no database is provided).
 */
export async function runAppTests(opts: {
  code: { root: string; commit: string | null };
  projectDir: string;
  config: SuiteConfig;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<AppTestsResult> {
  const tests = opts.config.tests ?? [];
  if (!tests.length) return { ran: false, results: [] };
  const dir = await tempWorkdir("tests");
  try {
    await materialize(opts.code.root, opts.code.commit, dir);
    const app = opts.config.app;
    const cwd = path.join(dir, opts.projectDir === "." ? "" : opts.projectDir, app?.root && app.root !== "." ? app.root : "");
    const src = opts.code.commit ? new GitSource(opts.code.root, opts.code.commit) : new FsSource(opts.code.root);
    const schemaLoad = app?.envSchema ? await loadEnvSchema(src, { ...app.envSchema, path: path.posix.join(opts.projectDir, app.envSchema.path) }) : null;
    const { env } = buildTestEnv({ schema: schemaLoad?.ok ? schemaLoad.schema : null, useExampleValues: app?.useExampleValues ?? true, explicit: app?.env ?? {}, generated: { CI: "1" } });
    for (const step of [app?.install, app?.build]) {
      if (!step) continue;
      const r = await runCommand(step, { cwd, env, timeoutMs: app?.installTimeoutMs ?? 600_000, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (!r.ok) return { ran: false, problem: `\`${step.join(" ")}\` failed (exit ${r.code}):\n${r.output.slice(-2000)}`, results: [] };
    }
    const results: TestCommandResult[] = [];
    for (const t of tests) {
      const r = await runCommand(t, { cwd, env, timeoutMs: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
      results.push({ command: t.join(" "), ok: r.ok, exitCode: r.code, timedOut: r.timedOut, durationMs: r.durationMs, output: r.output.slice(-4000) });
    }
    return { ran: true, results };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
