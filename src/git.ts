import { execFile } from "node:child_process";

export class GitError extends Error {
  override name = "GitError";
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(message);
    this.stderr = stderr;
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Run git with arguments (never through a shell). */
export function git(cwd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env }, encoding: "buffer" },
      (err, stdout, stderr) => {
        const out = stdout.toString("utf8");
        const errText = stderr.toString("utf8");
        if (err) {
          reject(new GitError(`git ${args.join(" ")} failed: ${errText.trim() || err.message}`, errText));
        } else {
          resolve({ stdout: out, stderr: errText });
        }
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

export async function gitOut(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}

export async function repoRoot(cwd: string): Promise<string> {
  return gitOut(cwd, ["rev-parse", "--show-toplevel"]);
}

/** A ref that does not name a commit; the message is meant for the user, not a stack trace. */
export class RefError extends GitError {
  override name = "RefError";
}

export async function resolveCommit(cwd: string, ref: string): Promise<string> {
  if (ref.startsWith("-")) throw new RefError(`refusing ref that looks like an option: ${ref}`);
  try {
    return await gitOut(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  } catch {
    const remotes = (await gitOut(cwd, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${ref}`]).catch(() => "")).split("\n").filter(Boolean);
    throw new RefError(`unknown ref "${ref}": it is not a commit in this repository${remotes.length ? `. Did you mean ${remotes.map((r) => `"${r}"`).join(" or ")}?` : ""}`);
  }
}

/** Parse `owner/name` from a GitHub remote URL (https or ssh). */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m || !m[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2] };
}
