import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject, ConfigError } from "../../src/config.ts";
import { normalizeRepoPath, projectPath, PathError } from "../../src/paths.ts";
import { FsSource, OverlaySource } from "../../src/source.ts";
import { tempDir } from "../helpers/project.ts";

describe("source path validation", () => {
  it("accepts normal relative paths", () => {
    expect(normalizeRepoPath("sql/a.sql")).toBe("sql/a.sql");
    expect(normalizeRepoPath("./sql//a.sql")).toBe("sql/a.sql");
    expect(projectPath("examples/shop", "sql/a.sql")).toBe("examples/shop/sql/a.sql");
  });

  it.each(["/etc/passwd", "../outside.sql", "sql/../../x.sql", "C:/x.sql", "sql\\a.sql", ".git/config", "a\0b"])("rejects %j", (p) => {
    expect(() => normalizeRepoPath(p)).toThrow(PathError);
  });

  it("rejects project paths that climb out of the project", () => {
    expect(() => projectPath("examples/shop", "../other/x.sql")).toThrow(PathError);
  });

  it("refuses to follow a symlink that leaves the repository", async () => {
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "secret.sql"), "SELECT 1");
    const repo = tempDir();
    fs.symlinkSync(path.join(outside, "secret.sql"), path.join(repo, "link.sql"));
    await expect(new FsSource(repo).readFile("link.sql")).rejects.toThrow(PathError);
  });

  it("overlay sources validate their override paths", () => {
    expect(() => new OverlaySource(new FsSource(tempDir()), new Map([["../x.sql", "SELECT 1"]]))).toThrow(PathError);
  });
});

describe("configuration loading", () => {
  const write = (files: Record<string, string>) => {
    const dir = tempDir();
    for (const [p, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), c);
    }
    return new FsSource(dir);
  };
  const config = (over: object = {}) => JSON.stringify({ version: 1, schema: "schema.sql", migrations: "migrations", checks: "checks.json", ...over });
  const checks = (list: object[]) => JSON.stringify({ version: 1, checks: list });

  it("loads a valid project and applies limit defaults", async () => {
    const p = await loadProject(write({ "crashpad.config.json": config(), "checks.json": checks([{ id: "a", category: "read", sql: "SELECT 1" }]) }), ".");
    expect(p?.config.limits.maxRows).toBe(1000);
    expect(p?.manifest.checks[0]?.params).toEqual([]);
  });

  it("returns null when there is no config", async () => {
    expect(await loadProject(write({}), ".")).toBeNull();
  });

  it.each([
    ["schema path escaping the repo", config({ schema: "../schema.sql" }), checks([])],
    ["absolute migrations dir", config({ migrations: "/tmp" }), checks([])],
    ["unknown config key", config({ extra: true }), checks([])],
    ["check source escaping the repo", config(), checks([{ id: "a", category: "read", source: "../../etc/x.sql" }])],
    ["both source and sql", config(), checks([{ id: "a", category: "read", source: "a.sql", sql: "SELECT 1" }])],
    ["neither source nor sql", config(), checks([{ id: "a", category: "read" }])],
    ["duplicate check ids", config(), checks([{ id: "a", category: "read", sql: "SELECT 1" }, { id: "a", category: "read", sql: "SELECT 2" }])],
    ["ordered on a write", config(), checks([{ id: "a", category: "write", sql: "DELETE FROM t", ordered: true }])],
    ["bad check id", config(), checks([{ id: "Has Spaces", category: "read", sql: "SELECT 1" }])],
  ])("rejects %s", async (_name, cfg, manifest) => {
    await expect(loadProject(write({ "crashpad.config.json": cfg, "checks.json": manifest }), ".")).rejects.toThrow(ConfigError);
  });
});
