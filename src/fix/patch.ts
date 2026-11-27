import { createHash } from "node:crypto";
import { structuredPatch } from "diff";
import type { FileEdit } from "./proposer.ts";

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** A git-compatible unified diff (applies with `git apply` from the repository root). */
export function unifiedPatch(edits: FileEdit[]): string {
  const out: string[] = [];
  for (const e of edits) {
    const p = structuredPatch(`a/${e.path}`, `b/${e.path}`, e.before, e.after, "", "", { context: 3 });
    out.push(`diff --git a/${e.path} b/${e.path}`);
    out.push(`--- a/${e.path}`);
    out.push(`+++ b/${e.path}`);
    for (const h of p.hunks) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const line of h.lines) out.push(line);
    }
  }
  return out.length ? out.join("\n") + "\n" : "";
}
