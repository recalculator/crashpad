import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RepairPolicy } from "./policy.ts";

export interface Installation {
  id: number;
  account: string;
  /** "all" or "selected", as chosen by the owner when installing the App. */
  repositorySelection: "all" | "selected";
  /** Repositories the App can access (full names, lowercased) as reported by GitHub. */
  repositories: string[];
  suspended: boolean;
}

export interface Companion {
  id: string;
  /** sha256 of the companion token; the token itself is never stored. */
  tokenHash: string;
  githubUserId: number;
  login: string;
  /** Installations the paired GitHub user could access when pairing. */
  installations: number[];
  name: string;
  createdAt: string;
  lastSeen: string | null;
  version: string | null;
  claude: { ready: boolean; message: string } | null;
  revoked: boolean;
}

export type JobStatus = "awaiting-approval" | "queued" | "leased" | "completed" | "superseded" | "cancelled" | "failed";

export interface Job {
  id: string;
  kind: "check" | "repair";
  installationId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  trusted: boolean;
  repairable: boolean;
  policyReason: string;
  status: JobStatus;
  dedupeKey: string;
  checkRunId: number | null;
  leasedBy: string | null;
  leaseExpires: number | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  trigger?: "auto" | "requested";
  requestedBy?: string;
  result?: { exitCode: number; headline: string; prUrl?: string; message?: string };
  supersededBy?: string;
}

export interface RepoPolicy {
  repair: RepairPolicy;
}

interface State {
  installations: Record<string, Installation>;
  companions: Record<string, Companion>;
  jobs: Record<string, Job>;
  repoPolicies: Record<string, RepoPolicy>;
  deliveries: string[];
}

export function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

/** In-memory state persisted to a JSON file (atomic rename). One service process. */
export class ServiceStore {
  private s: State;
  private file: string | null;
  constructor(file: string | null) {
    this.file = file;
    this.s = { installations: {}, companions: {}, jobs: {}, repoPolicies: {}, deliveries: [] };
    if (file && fs.existsSync(file)) this.s = { ...this.s, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Replayed webhook deliveries are ignored (GitHub may redeliver). */
  seenDelivery(id: string | undefined): boolean {
    if (!id) return false;
    if (this.s.deliveries.includes(id)) return true;
    this.s.deliveries.push(id);
    if (this.s.deliveries.length > 5000) this.s.deliveries.splice(0, 1000);
    return false;
  }

  installation(id: number): Installation | null {
    return this.s.installations[String(id)] ?? null;
  }
  putInstallation(i: Installation): void {
    this.s.installations[String(i.id)] = i;
    this.save();
  }
  deleteInstallation(id: number): void {
    delete this.s.installations[String(id)];
    for (const j of Object.values(this.s.jobs)) if (j.installationId === id && isActive(j)) this.update(j, { status: "cancelled" });
    this.save();
  }

  /** The App can act on `repo` through `installationId` only if the owner's selection includes it. */
  repoAllowed(installationId: number, repo: string): boolean {
    const i = this.installation(installationId);
    if (!i || i.suspended) return false;
    return i.repositories.includes(repo.toLowerCase());
  }

  createCompanion(c: Omit<Companion, "id" | "tokenHash" | "createdAt" | "lastSeen" | "version" | "claude" | "revoked">): { companion: Companion; token: string } {
    const token = `cpc_${randomBytes(32).toString("base64url")}`;
    const companion: Companion = { ...c, id: randomBytes(8).toString("hex"), tokenHash: hashToken(token), createdAt: new Date().toISOString(), lastSeen: null, version: null, claude: null, revoked: false };
    this.s.companions[companion.id] = companion;
    this.save();
    return { companion, token };
  }

  companionByToken(token: string): Companion | null {
    const h = Buffer.from(hashToken(token), "hex");
    for (const c of Object.values(this.s.companions)) {
      if (c.revoked) continue;
      const k = Buffer.from(c.tokenHash, "hex");
      if (k.length === h.length && timingSafeEqual(k, h)) return c;
    }
    return null;
  }

  companions(): Companion[] {
    return Object.values(this.s.companions);
  }

  touchCompanion(c: Companion, patch: Partial<Companion>): void {
    Object.assign(c, patch, { lastSeen: new Date().toISOString() });
    this.save();
  }

  jobs(): Job[] {
    return Object.values(this.s.jobs);
  }
  job(id: string): Job | null {
    return this.s.jobs[id] ?? null;
  }
  addJob(j: Job): void {
    this.s.jobs[j.id] = j;
    this.save();
  }
  update(j: Job, patch: Partial<Job>): Job {
    Object.assign(j, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return j;
  }

  policy(repo: string): RepoPolicy | null {
    return this.s.repoPolicies[repo.toLowerCase()] ?? null;
  }
  setPolicy(repo: string, p: RepoPolicy): void {
    this.s.repoPolicies[repo.toLowerCase()] = p;
    this.save();
  }
}

export function isActive(j: Job): boolean {
  return j.status === "queued" || j.status === "leased" || j.status === "awaiting-approval";
}
