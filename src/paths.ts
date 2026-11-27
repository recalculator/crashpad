import path from "node:path";

/** Raised when a configured or proposed path would escape the repository. */
export class PathError extends Error {
  override name = "PathError";
}

/**
 * Normalize a repository-relative POSIX path and reject anything that could
 * escape the repository root: absolute paths, `..` segments that climb above
 * the root, backslashes (ambiguous on Windows), NUL bytes, and `.git` internals.
 */
export function normalizeRepoPath(input: string, what = "path"): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathError(`${what} must be a non-empty string`);
  }
  if (input.includes("\0")) throw new PathError(`${what} contains a NUL byte`);
  if (input.includes("\\")) throw new PathError(`${what} must use forward slashes: ${input}`);
  if (path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    throw new PathError(`${what} must be relative to the repository: ${input}`);
  }
  const normalized = path.posix.normalize(input).replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new PathError(`${what} escapes the repository: ${input}`);
  }
  const segments = normalized.split("/");
  if (segments.includes(".git")) throw new PathError(`${what} may not point into .git: ${input}`);
  return normalized === "" ? "." : normalized;
}

/** Join a project-relative path onto the project directory, keeping it inside the repo. */
export function projectPath(projectDir: string, rel: string, what = "path"): string {
  const project = normalizeRepoPath(projectDir, "project directory");
  const relNorm = normalizeRepoPath(rel, what);
  if (relNorm.startsWith("../") || relNorm === "..") {
    throw new PathError(`${what} escapes the project: ${rel}`);
  }
  const joined = project === "." ? relNorm : path.posix.join(project, relNorm);
  return normalizeRepoPath(joined, what);
}
