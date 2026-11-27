import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Agent, AgentRun, AgentRunInput, AgentStatus } from "./agent.ts";

/**
 * Adapter for the user's installed, signed-in Claude Code CLI.
 *
 * - Authentication is checked only through `claude auth status --json` (supported
 *   CLI behavior). Crashpad never reads, copies, or uploads Claude's credential
 *   files or keychain entries, and keeps none of the account details it prints.
 * - In `subscription` mode (the default), ANTHROPIC_API_KEY and
 *   ANTHROPIC_AUTH_TOKEN are removed from Claude's environment, because Claude
 *   Code prefers an API key over a subscription login whenever one is present in
 *   print mode. `--bare` is never used: it never reads OAuth credentials.
 * - Claude runs non-interactively (`-p`) with `--permission-mode dontAsk` and an
 *   explicit tool allowlist: anything not allowed is denied, never prompted.
 *   Permission bypass flags are never passed.
 * - Work is bounded with `--max-turns`, optionally `--max-budget-usd` (Claude
 *   Code's own estimate), a wall-clock deadline, and cancellation.
 */

export type ClaudeAuthMode = "subscription" | "existing";

export interface ClaudeOptions {
  bin?: string;
  auth?: ClaudeAuthMode;
  model?: string;
  /** Extra environment for the child (tests). */
  env?: Record<string, string>;
}

const STRIP_FOR_SUBSCRIPTION = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const SUBSCRIPTION_METHODS = new Set(["claude.ai", "oauth_token"]);

interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: NodeJS.ErrnoException;
}

function exec(bin: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<Exec> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* gone */
      }
    };
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (r: Exec) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    child.on("error", (err) => done({ code: null, stdout, stderr, timedOut, cancelled, spawnError: err as NodeJS.ErrnoException }));
    child.on("close", (code) => done({ code, stdout, stderr, timedOut, cancelled }));
  });
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  loginExpiresAt: string | null;
  subscriptionType: string | null;
}

/** Keep only non-identifying fields; the CLI's account details (email, organization) are discarded. */
export function pickAuthFields(json: Record<string, unknown>): ClaudeAuthStatus {
  const s = (k: string) => (typeof json[k] === "string" ? (json[k] as string) : null);
  return { loggedIn: json.loggedIn === true, authMethod: s("authMethod"), apiProvider: s("apiProvider"), loginExpiresAt: s("loginExpiresAt"), subscriptionType: s("subscriptionType") };
}

const AUTH_ERROR = /not logged in|please run \/login|run `claude auth login`|authentication[_ ]error|invalid api key|oauth token (has )?expired|token has expired|401\b|unauthorized|session expired/i;
const USAGE_ERROR = /usage limit|limit reached|rate[_ ]limit|quota|credit balance is too low|out of credits|429\b|overloaded/i;

export function classifyFailure(text: string): "auth" | "usage" | null {
  if (AUTH_ERROR.test(text)) return "auth";
  if (USAGE_ERROR.test(text)) return "usage";
  return null;
}

export class ClaudeCodeAgent implements Agent {
  readonly name = "claude-code";
  readonly bin: string;
  readonly auth: ClaudeAuthMode;
  private model: string | undefined;
  private extraEnv: Record<string, string>;

  constructor(opts: ClaudeOptions = {}) {
    this.bin = opts.bin ?? process.env.CRASHPAD_CLAUDE_BIN ?? "claude";
    this.auth = opts.auth ?? "subscription";
    this.model = opts.model;
    this.extraEnv = opts.env ?? {};
  }

  /** The environment Claude Code runs with. */
  childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };
    if (this.auth === "subscription") for (const k of STRIP_FOR_SUBSCRIPTION) delete env[k];
    // Nested Claude Code sessions inherit this marker; a repair run is its own session.
    delete env.CLAUDECODE;
    return env;
  }

  async status(): Promise<AgentStatus> {
    const v = await exec(this.bin, ["--version"], { env: this.childEnv(), timeoutMs: 20_000 });
    if (v.spawnError?.code === "ENOENT") return { ready: false, reason: "not-installed", message: `Claude Code is not installed (no \`${this.bin}\` on PATH). Install it from https://code.claude.com and sign in with \`claude auth login\`.` };
    if (v.code !== 0) return { ready: false, reason: "unavailable", message: `\`${this.bin} --version\` failed: ${(v.stderr || v.stdout).trim().slice(0, 300)}` };
    const version = v.stdout.trim().split(/\s+/)[0] ?? "unknown";
    const a = await exec(this.bin, ["auth", "status", "--json"], { env: this.childEnv(), timeoutMs: 20_000 });
    let parsed: ClaudeAuthStatus | null = null;
    try {
      parsed = pickAuthFields(JSON.parse(a.stdout));
    } catch {
      parsed = null;
    }
    if (!parsed) return { ready: false, reason: "unavailable", version, message: `could not read \`${this.bin} auth status --json\` (Claude Code ${version} may be too old; 2.1.268 or later reports JSON)` };
    if (!parsed.loggedIn) return { ready: false, reason: "not-authenticated", version, auth: parsed, message: "Claude Code is not signed in. Run `claude auth login`." };
    if (this.auth === "subscription" && !SUBSCRIPTION_METHODS.has(parsed.authMethod ?? "")) {
      return {
        ready: false,
        reason: "not-authenticated",
        version,
        auth: parsed,
        message: `Claude Code is signed in with ${parsed.authMethod}, not a Claude subscription. Run \`claude auth login\`, or pass --claude-auth existing to use the current method (which may bill an API account).`,
      };
    }
    if (parsed.loginExpiresAt && Date.parse(parsed.loginExpiresAt) < Date.now()) {
      return { ready: false, reason: "not-authenticated", version, auth: parsed, message: `Claude Code's sign-in expired at ${parsed.loginExpiresAt}. Run \`claude auth login\`.` };
    }
    return { ready: true, version, auth: parsed, message: `Claude Code ${version}, signed in (${parsed.authMethod}${parsed.subscriptionType ? `, ${parsed.subscriptionType}` : ""})` };
  }

  /** Arguments for one non-interactive run. Exported for tests: no bypass flags, ever. */
  args(input: AgentRunInput): string[] {
    const args = ["-p", input.prompt, "--output-format", "json", "--permission-mode", "dontAsk"];
    args.push("--allowedTools", ...input.allowedTools);
    args.push("--disallowedTools", "WebFetch", "WebSearch", "Bash(git push *)", "Bash(git commit *)", "Bash(git reset *)", "Bash(rm -rf *)");
    // Only the tools Crashpad grants: no MCP servers from the user's configuration.
    args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    args.push("--max-turns", String(input.maxTurns));
    if (input.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(input.maxBudgetUsd));
    if (this.model) args.push("--model", this.model);
    if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
    else args.push("--session-id", input.sessionId ?? randomUUID());
    return args;
  }

  async run(input: AgentRunInput): Promise<AgentRun> {
    const started = Date.now();
    const args = this.args(input);
    const r = await exec(this.bin, args, { cwd: input.cwd, env: this.childEnv(), timeoutMs: input.timeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
    const base = { durationMs: Date.now() - started, sessionId: input.resumeSessionId ?? args[args.indexOf("--session-id") + 1] ?? null };
    if (r.spawnError?.code === "ENOENT") return { ...base, status: "not-installed", summary: `\`${this.bin}\` not found` };
    if (r.cancelled) return { ...base, status: "cancelled", summary: "cancelled" };
    if (r.timedOut) return { ...base, status: "deadline", summary: `stopped after the ${input.timeoutMs} ms attempt deadline` };
    let json: Record<string, unknown> | null = null;
    try {
      const line = r.stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
      json = line ? (JSON.parse(line) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    const resultText = typeof json?.result === "string" ? json.result : "";
    const meta = {
      ...(typeof json?.session_id === "string" ? { sessionId: json.session_id } : {}),
      ...(typeof json?.num_turns === "number" ? { turns: json.num_turns } : {}),
      ...(typeof json?.total_cost_usd === "number" ? { costUsd: json.total_cost_usd } : {}),
    };
    const failureText = `${resultText}\n${r.stderr}\n${json ? "" : r.stdout}`;
    if (!json || r.code !== 0 || json.is_error === true || (typeof json.subtype === "string" && json.subtype !== "success")) {
      const subtype = typeof json?.subtype === "string" ? json.subtype : null;
      if (subtype === "error_max_turns") return { ...base, ...meta, status: "limit", summary: `stopped at the ${input.maxTurns}-turn limit`, text: resultText };
      if (subtype === "error_max_budget_usd") return { ...base, ...meta, status: "limit", summary: "stopped at the budget limit", text: resultText };
      const kind = classifyFailure(failureText);
      if (kind === "auth") return { ...base, ...meta, status: "not-authenticated", summary: "Claude Code reported an authentication problem (expired or missing sign-in). Run `claude auth login`." };
      if (kind === "usage") return { ...base, ...meta, status: "usage-exhausted", summary: "Claude Code reported that usage limits are exhausted or rate-limited. Try again later." };
      return { ...base, ...meta, status: "error", summary: `Claude Code exited with ${r.code}${subtype ? ` (${subtype})` : ""}: ${failureText.trim().slice(0, 400)}` };
    }
    return { ...base, ...meta, status: "completed", summary: resultText.trim().slice(0, 2000) || "(no summary)", text: resultText };
  }
}
