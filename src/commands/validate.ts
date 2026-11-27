import path from "node:path";
import { loadProject, ConfigError } from "../config.ts";
import { loadFixtures } from "../fixtures.ts";
import { repoRoot } from "../git.ts";
import { PathError } from "../paths.ts";
import { projectDirFor } from "../context.ts";
import { FsSource } from "../source.ts";
import { ensureParser } from "../sql/parser.ts";
import type { Values } from "../cli.ts";

/** Validate configuration, manifest, and fixture SQL without touching a database. */
export async function cmdValidate(v: Values, cwd: string): Promise<number> {
  await ensureParser();
  const root = await repoRoot(cwd).catch(() => cwd);
  const projectDir = projectDirFor(root, cwd, v.project);
  const source = new FsSource(root);
  try {
    const project = await loadProject(source, projectDir);
    if (!project) {
      process.stderr.write(`crashpad: no crashpad.config.json in ${projectDir}\n`);
      return 2;
    }
    const fixtures = await loadFixtures(project, source);
    let bad = 0;
    for (const f of fixtures.values()) {
      if (f.invalid) {
        bad++;
        process.stdout.write(`✗ ${f.def.id} (${f.origin.path}): ${f.invalid}\n`);
      } else {
        process.stdout.write(`✓ ${f.def.id} [${f.def.category}] ${f.origin.kind === "file" ? f.origin.path : "inline"}\n`);
      }
    }
    if (project.paths.schema && !(await source.readFile(project.paths.schema))) {
      bad++;
      process.stdout.write(`✗ schema file not found: ${project.paths.schema}\n`);
    }
    process.stdout.write(bad ? `\n${bad} problem(s) found\n` : `\nconfiguration OK: ${fixtures.size} check(s)\n`);
    return bad ? 2 : 0;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof PathError) {
      process.stderr.write(`crashpad: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
