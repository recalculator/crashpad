/**
 * Which pull requests the companion may run code for, and which may be repaired.
 *
 * Running Crashpad executes the PR's code and SQL (migrations, the app, its tests)
 * on the owner's machine, so it is gated:
 * - TRUSTED: a branch of the same repository, opened by someone the repository
 *   trusts (author_association OWNER, MEMBER, or COLLABORATOR). Checks run
 *   automatically.
 * - UNTRUSTED: a fork, or an author without that association. Nothing runs until
 *   a user with write access approves the run on the check ("Run Crashpad").
 *   Untrusted PRs are never repaired, even after approval.
 *
 * Loop prevention: a PR whose head branch is a Crashpad fix branch, or that was
 * opened by the Crashpad App itself, is checked (so its result is visible) but
 * never repaired, so generated fix PRs cannot trigger further repairs.
 */

export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
export const FIX_BRANCH_PREFIX = "crashpad/fix-";
export const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export interface PullRequestFacts {
  baseRepo: string;
  headRepo: string | null;
  headRef: string;
  authorLogin: string;
  authorType: string;
  authorAssociation: string;
}

export interface Decision {
  trusted: boolean;
  repairable: boolean;
  reason: string;
}

export function evaluatePullRequest(pr: PullRequestFacts, appBotLogin: string | null): Decision {
  const fork = !pr.headRepo || pr.headRepo.toLowerCase() !== pr.baseRepo.toLowerCase();
  const isFixPr = pr.headRef.startsWith(FIX_BRANCH_PREFIX) || (pr.authorType === "Bot" && !!appBotLogin && pr.authorLogin === appBotLogin);
  if (fork) return { trusted: false, repairable: false, reason: "pull request from a fork: runs need approval by a user with write access, and it is never repaired" };
  if (!TRUSTED_ASSOCIATIONS.has(pr.authorAssociation) && !isFixPr) {
    return { trusted: false, repairable: false, reason: `author association ${pr.authorAssociation}: runs need approval by a user with write access, and it is never repaired` };
  }
  if (isFixPr) return { trusted: true, repairable: false, reason: "a Crashpad fix pull request: checked, never repaired (loop prevention)" };
  return { trusted: true, repairable: true, reason: `same-repository branch by ${pr.authorAssociation.toLowerCase()}` };
}

export interface RepairPolicy {
  /** Automatically start a repair when a trusted PR's check fails. Off unless the owner opts in. */
  autoRepair: boolean;
  /** Most repair jobs per pull request (across all of its commits). */
  maxRepairsPerPr: number;
}

export const DEFAULT_REPAIR_POLICY: RepairPolicy = { autoRepair: false, maxRepairsPerPr: 2 };

export function mayStartRepair(d: Decision, policy: RepairPolicy, priorRepairsForPr: number, priorRepairsForSha: number, trigger: "auto" | "requested"): { ok: boolean; reason: string } {
  if (!d.repairable) return { ok: false, reason: d.reason };
  if (trigger === "auto" && !policy.autoRepair) return { ok: false, reason: "automatic repair is off for this repository (opt-in)" };
  if (priorRepairsForSha > 0) return { ok: false, reason: "a repair was already attempted for this exact commit" };
  if (priorRepairsForPr >= policy.maxRepairsPerPr) return { ok: false, reason: `the repair limit for this pull request (${policy.maxRepairsPerPr}) was reached` };
  return { ok: true, reason: trigger === "auto" ? "automatic repair policy" : "requested by a user with write access" };
}
