import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveContext, suiteInputFrom } from "../../src/context.ts";
import { discoverer } from "../../src/discovery/index.ts";
import { renderSuiteMarkdown } from "../../src/suite/markdown.ts";
import { runSuite } from "../../src/suite/runner.ts";
import { DB_URL, tempDir } from "../helpers/project.ts";
import { buildScenarioRepo, DRIZZLE_APP, type Scenario } from "../helpers/scenario.ts";

/**
 * Schema compatibility for a Drizzle project with no committed migrations (shaped like the
 * real-project trial's Next.js app, which applies its schema with `drizzle-kit push`).
 * The project's real drizzle-kit exports each version's schema, the DDL runs on a real
 * PostgreSQL server, and the app is a real process. Dependencies are linked from
 * Crashpad's own node_modules instead of installed from the network.
 */

const NODE_MODULES = path.resolve(import.meta.dirname, "../../node_modules");
const settings = { app: { install: ["ln", "-s", NODE_MODULES, "node_modules"] } };

beforeAll(() => {
  process.env.CRASHPAD_HOME = tempDir("crashpad-home-");
});

function scenario(name: string, replace: Scenario["replace"] = []): Scenario {
  return { name, dir: path.join(tempDir(), "none"), title: name, description: "", mode: "check", expectedExit: 0, replace };
}

async function check(replace: Scenario["replace"]) {
  const repo = buildScenarioRepo(scenario("drizzle", replace), tempDir(), DRIZZLE_APP);
  const ctx = await resolveContext({ cwd: repo, base: "main", head: "change", databaseUrl: DB_URL });
  const { report } = await runSuite({ ...suiteInputFrom(ctx, DB_URL), discover: discoverer(), settings });
  return { report, md: renderSuiteMarkdown(report), byId: new Map(report.findings.map((f) => [f.id, f])) };
}

const SCHEMA = "src/db/schema.ts";

describe("Drizzle schema compatibility (no committed migrations)", () => {
  it("unchanged schema: every table and enum is compatible; coverage stays partial and says why", async () => {
    const { report, md, byId } = await check([]);
    expect(report.exitCode, md).toBe(0);
    expect(byId.get("database:schema:ddl")?.classification).toBe("pass");
    expect(byId.get("database:schema:table:projects")?.classification).toBe("pass");
    expect(byId.get("database:schema:table:tasks")?.classification).toBe("pass");
    expect(byId.get("database:schema:enum:task_status")?.classification).toBe("pass");
    const db = report.coverage.find((c) => c.area === "database")!;
    expect(db.status).toBe("partial");
    expect(db.ran.join("\n")).toMatch(/schema compatibility \(ORM-derived schemas, not migrations\)[\s\S]*4 synthetic sample row\(s\)[\s\S]*4 accepted/);
    expect(db.missing.join("\n")).toMatch(/no committed migrations[\s\S]*neither generated nor executed[\s\S]*synthetic[\s\S]*application's own queries are not exercised/);
    expect(report.headline).toMatch(/All \d+ check\(s\) passed \(database schema compatibility \d+, config\/startup \d+\)/);
    // The app started against a database built from the exported schema.
    expect(byId.get("config:startup")?.classification, md).toBe("pass");
    // The project's own commands ran on both versions, reported apart from Crashpad's checks.
    expect(report.projectCommands.results.map((c) => [c.command, c.classification])).toEqual([
      ["npm run --silent build", "pass"],
      ["npm run --silent test", "pass"],
    ]);
    expect(report.findings.some((f) => /build|test/.test(f.id) && f.area !== "config")).toBe(false);
    expect(md).toMatch(/### Project commands[\s\S]*does not show database, API, permission, or workflow behavior/);
  });

  it("a new NOT NULL column without a default: the baseline's rows are rejected, with the PostgreSQL error", async () => {
    const { report, md, byId } = await check([
      { file: SCHEMA, find: `  oneLiner: text("one_liner").notNull(),`, with: `  oneLiner: text("one_liner").notNull(),\n  ownerEmail: text("owner_email").notNull(),` },
    ]);
    expect(report.exitCode, md).toBe(1);
    const f = byId.get("database:schema:table:projects")!;
    expect(f.classification).toBe("regression");
    expect(f.reason).toBe("not_null_violation");
    expect(f.message).toMatch(/valid under the baseline schema is rejected by the candidate schema[\s\S]*owner_email/);
    expect(f.evidence.find((e) => e.label === "PostgreSQL error")?.detail).toMatch(/23502/);
    expect(f.evidence.find((e) => e.kind === "diff")?.detail).toContain("+ column owner_email text NOT NULL without a default");
    expect(f.subject.file).toBe(SCHEMA);
    // Tables that reference the rejected rows are still tested (against stand-in parent rows), not blocked.
    expect(byId.get("database:schema:table:tasks")?.classification, md).toBe("pass");
    // The build and tests still pass; that is reported as the project's result, not as database coverage.
    expect(report.projectCommands.results.every((c) => c.classification === "pass")).toBe(true);
  });

  it("removed enum value, dropped column, and changed type are each reported precisely", async () => {
    const { report, md, byId } = await check([
      { file: SCHEMA, find: `"done", "blocked"]`, with: `"done"]` },
      { file: SCHEMA, find: `    description: text("description"),\n`, with: "" },
      { file: SCHEMA, find: `seq: integer("seq").notNull(),`, with: `seq: text("seq").notNull(),` },
    ]);
    expect(report.exitCode, md).toBe(1);
    const e = byId.get("database:schema:enum:task_status")!;
    expect([e.classification, e.reason]).toEqual(["regression", "enum-value-removed"]);
    expect(e.message).toContain("'blocked'");
    const t = byId.get("database:schema:table:tasks")!;
    expect([t.classification, t.reason]).toEqual(["regression", "column-dropped"]);
    expect(t.evidence.find((x) => x.kind === "diff")?.detail).toMatch(/- column description[\s\S]*~ column seq: integer → text/);
  });

  it("a type change alone is not decided from synthetic samples", async () => {
    const { report, byId } = await check([{ file: SCHEMA, find: `seq: integer("seq").notNull(),`, with: `seq: text("seq").notNull(),` }]);
    expect(byId.get("database:schema:table:tasks")?.classification).toBe("inconclusive");
    expect(byId.get("database:schema:table:tasks")?.reason).toBe("type-changed");
    expect(report.exitCode).toBe(2);
  });

  it("compatible additions pass: a nullable column and a new table", async () => {
    const { report, md, byId } = await check([
      { file: SCHEMA, find: `  githubRepo: text("github_repo"),`, with: `  githubRepo: text("github_repo"),\n  archivedAt: timestamp("archived_at", { withTimezone: true }),` },
      { file: SCHEMA, find: `export const tasks = pgTable(`, with: `export const notes = pgTable("notes", { id: uuid("id").primaryKey().defaultRandom(), body: text("body").notNull() });\n\nexport const tasks = pgTable(` },
    ]);
    expect(report.exitCode, md).toBe(0);
    expect(byId.get("database:schema:table:projects")?.candidate.summary).toMatch(/accepted \(1 compatible change/);
    expect(report.coverage.find((c) => c.area === "database")!.ran.join("\n")).toContain("new table(s): notes");
  });

  it("a schema module that no longer exports is a regression, and the candidate's runtime checks are not run against a guessed database", async () => {
    const { report, md, byId } = await check([{ file: SCHEMA, find: `export const tasks = pgTable(`, with: `export const tasks = pgTable(undefinedThing,` }]);
    expect(report.exitCode, md).toBe(1);
    expect(byId.get("database:schema:ddl")?.reason).toBe("export-failed");
    expect(byId.get("config:startup")?.classification, byId.get("config:startup")?.message).toBe("inconclusive");
    // The build needs a database; without the candidate's, it is not run rather than blamed on the change.
    const build = report.projectCommands.results.find((c) => c.role === "build")!;
    expect([build.classification, build.candidate.summary]).toEqual(["undecided", "the candidate schema could not be built (see the database area)"]);
  });

  it("a build the change broke is a project-command failure, reported separately from Crashpad's checks", async () => {
    const { report, md } = await check([{ file: "build.js", find: `fs.writeFileSync("dist/built.txt", "ok\\n");`, with: `throw new Error("broken build");` }]);
    expect(report.exitCode, md).toBe(1);
    const b = report.projectCommands.results.find((c) => c.role === "build")!;
    expect(b.classification).toBe("broken");
    expect(b.candidate.output).toContain("broken build");
    expect(report.headline).toMatch(/^1 project command\(s\) broken by this change \(`npm run --silent build`\); Crashpad checks: /);
    // Schema compatibility still ran: a compiler or build failure is not a database finding.
    expect(report.findings.filter((f) => f.area === "database").every((f) => f.classification === "pass")).toBe(true);
  });
});

describe("setup on a Drizzle project (local directory)", () => {
  it("reports schema compatibility (not migrations), the project commands, and the directory it analyzed", async () => {
    const { main } = await import("../../src/cli.ts");
    const { vi } = await import("vitest");
    const repo = buildScenarioRepo(scenario("setup"), tempDir(), DRIZZLE_APP);
    // A clone whose origin is another checkout, as in the trial.
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["remote", "add", "origin", "/somewhere/else/original-checkout"], { cwd: repo });
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
    try {
      expect(await main(["setup", "--repo-dir", repo, "--database-url", DB_URL], tempDir())).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(out).toContain(`${repo} (settings shared with origin /somewhere/else/original-checkout)`);
    expect(out).toMatch(/◐ Database compatibility\s+partial[\s\S]*found: Drizzle ORM schema: src\/db\/schema.ts[\s\S]*missing: schema compatibility only: no migration sequence/);
    expect(out).toMatch(/Project commands \(the project's own scripts[\s\S]*build: npm run --silent build[\s\S]*test: npm run --silent test/);
    expect(out).toContain("inside a local repository, crashpad settings --set");
  });
});
