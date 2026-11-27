import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { git } from "../git.ts";
import { redactText } from "./env.ts";

/** Write the files of `commit` (or the working tree, tracked + untracked-not-ignored, when null) into `dest`. */
export async function materialize(repoRoot: string, commit: string | null, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  if (commit) {
    await new Promise<void>((resolve, reject) => {
      const archive = spawn("git", ["archive", "--format=tar", commit], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
      const tar = spawn("tar", ["-x", "-f", "-", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      archive.stderr.on("data", (d) => (err += d));
      tar.stderr.on("data", (d) => (err += d));
      archive.stdout.pipe(tar.stdin);
      let pending = 2;
      const done = (code: number | null) => {
        if (code !== 0) reject(new Error(`could not export ${commit.slice(0, 12)}: ${err.trim() || `exit ${code}`}`));
        else if (--pending === 0) resolve();
      };
      archive.on("close", done);
      tar.on("close", done);
    });
    return;
  }
  const { stdout } = await git(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  for (const rel of stdout.split("\0").filter(Boolean)) {
    const src = path.join(repoRoot, rel);
    const st = await fs.lstat(src).catch(() => null);
    if (!st || !st.isFile()) continue; // deleted, directory (submodule), or symlink: never followed
    const dst = path.join(dest, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }
}

export interface CommandResult {
  ok: boolean;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  output: string;
}

const TAIL_BYTES = 8000;

function tail(s: string): string {
  return s.length > TAIL_BYTES ? `…${s.slice(-TAIL_BYTES)}` : s;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

/** Run a command (argv, never a shell) to completion with a deadline. */
export function runCommand(argv: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let cancelled = false;
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (err) {
      resolve({ ok: false, code: null, signal: null, timedOut: false, cancelled: false, durationMs: 0, output: (err as Error).message });
      return;
    }
    const onData = (d: Buffer) => {
      output = tail(output + d.toString("utf8"));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 3000).unref();
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 3000).unref();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      output = tail(`${output}${err.message}\n`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ ok: code === 0 && !timedOut && !cancelled, code, signal, timedOut, cancelled, durationMs: Date.now() - started, output: redactText(output, opts.env) });
    });
  });
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(500, () => (s.destroy(), resolve(false)));
  });
}

export type StartOutcome =
  | { status: "ready"; readyMs: number }
  | { status: "exited"; code: number | null; signal: string | null; afterMs: number }
  | { status: "readiness-timeout"; afterMs: number; lastProbe: string }
  | { status: "spawn-failed"; message: string };

export class AppProcess {
  readonly port: number;
  readonly baseUrl: string;
  private child: ChildProcess | null = null;
  private log = "";
  private exited: { code: number | null; signal: string | null } | null = null;
  private env: Record<string, string>;
  readonly command: string[];
  readonly cwd: string;

  constructor(opts: { command: string[]; cwd: string; env: Record<string, string>; port: number }) {
    this.command = opts.command;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.port = opts.port;
    this.baseUrl = `http://127.0.0.1:${opts.port}`;
  }

  logs(): string {
    return redactText(this.log, this.env);
  }

  hasExited(): boolean {
    return this.exited !== null;
  }

  exitInfo(): { code: number | null; signal: string | null } | null {
    return this.exited;
  }

  /** Start and wait until ready, the process exits, or the readiness deadline passes. */
  async start(readiness: { path?: string; timeoutMs: number }, signal?: AbortSignal): Promise<StartOutcome> {
    const started = Date.now();
    try {
      this.child = spawn(this.command[0]!, this.command.slice(1), { cwd: this.cwd, env: this.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (err) {
      return { status: "spawn-failed", message: (err as Error).message };
    }
    const onData = (d: Buffer) => {
      this.log = tail(this.log + d.toString("utf8"));
    };
    this.child.stdout?.on("data", onData);
    this.child.stderr?.on("data", onData);
    let spawnError: string | null = null;
    this.child.on("error", (err) => {
      spawnError = err.message;
      this.log = tail(`${this.log}${err.message}\n`);
    });
    this.child.on("exit", (code, sig) => {
      this.exited = { code, signal: sig };
    });
    let lastProbe = "no response yet";
    while (true) {
      if (spawnError) return { status: "spawn-failed", message: spawnError };
      if (this.exited) return { status: "exited", code: this.exited.code, signal: this.exited.signal, afterMs: Date.now() - started };
      if (signal?.aborted) return { status: "readiness-timeout", afterMs: Date.now() - started, lastProbe: "cancelled" };
      if (Date.now() - started > readiness.timeoutMs) return { status: "readiness-timeout", afterMs: Date.now() - started, lastProbe };
      if (readiness.path) {
        try {
          const res = await fetch(`${this.baseUrl}${readiness.path}`, { signal: AbortSignal.timeout(1000) });
          await res.arrayBuffer().catch(() => undefined);
          if (res.status >= 200 && res.status < 300) return { status: "ready", readyMs: Date.now() - started };
          lastProbe = `GET ${readiness.path} → ${res.status}`;
        } catch (err) {
          lastProbe = `GET ${readiness.path} → ${(err as Error).cause ? String((err as { cause: { code?: string } }).cause.code ?? "error") : (err as Error).name}`;
        }
      } else if (await portOpen(this.port)) {
        return { status: "ready", readyMs: Date.now() - started };
      } else {
        lastProbe = `port ${this.port} not accepting connections`;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const gone = new Promise<void>((r) => child.once("exit", () => r()));
    killGroup(child, "SIGTERM");
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), 3000);
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
    clearTimeout(timer);
  }
}

export async function tempWorkdir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `crashpad-${prefix}-`));
}
