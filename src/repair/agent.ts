/**
 * A repair agent edits files in an isolated workspace. Crashpad never trusts its
 * report: every attempt is verified independently, and a successful exit means
 * nothing on its own.
 */

export interface AgentStatus {
  ready: boolean;
  reason?: "not-installed" | "not-authenticated" | "unavailable";
  version?: string;
  auth?: { loggedIn: boolean; authMethod: string | null; apiProvider: string | null; loginExpiresAt: string | null; subscriptionType: string | null };
  message: string;
}

export interface AgentRunInput {
  cwd: string;
  prompt: string;
  /** Session to create on the first attempt. */
  sessionId?: string;
  /** Session to continue on later attempts (feedback). */
  resumeSessionId?: string;
  /** Tool rules the agent may use (Claude Code permission rule syntax). */
  allowedTools: string[];
  maxTurns: number;
  maxBudgetUsd?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type AgentRunStatus =
  | "completed"
  | "limit"
  | "deadline"
  | "cancelled"
  | "not-installed"
  | "not-authenticated"
  | "usage-exhausted"
  | "error";

export interface AgentRun {
  status: AgentRunStatus;
  summary: string;
  text?: string;
  sessionId: string | null;
  turns?: number;
  costUsd?: number;
  durationMs: number;
}

export interface Agent {
  readonly name: string;
  status(): Promise<AgentStatus>;
  run(input: AgentRunInput): Promise<AgentRun>;
}

/** Statuses after which more attempts cannot help. */
export const TERMINAL: ReadonlySet<AgentRunStatus> = new Set(["cancelled", "not-installed", "not-authenticated", "usage-exhausted"]);
