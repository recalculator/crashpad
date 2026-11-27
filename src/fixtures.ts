import { checkSourcePath, type CheckDef, type LoadedProject } from "./config.ts";
import { firstTokenOffset, lineCol, maxParamNumber, parseStatements, SqlParseError, walk } from "./sql/parser.ts";
import type { Source } from "./source.ts";

export interface FixtureOrigin {
  kind: "file" | "inline";
  /** Repo-relative path of the SQL file, or of the manifest for inline SQL. */
  path: string;
  /** 1-based line of the statement's first token within `path`. */
  line: number;
}

export interface Fixture {
  def: CheckDef;
  sql: string;
  origin: FixtureOrigin;
  /** Set when the fixture cannot be executed as defined. */
  invalid?: string;
}

const READ_KINDS = new Set(["SelectStmt"]);
const WRITE_KINDS = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);

/** Validate that the SQL is a single statement of a kind allowed for the check category. */
export function validateFixtureSql(def: CheckDef, sql: string): string | undefined {
  let stmts;
  try {
    stmts = parseStatements(sql);
  } catch (err) {
    if (err instanceof SqlParseError) return `SQL does not parse: ${err.message}`;
    throw err;
  }
  if (stmts.length !== 1) return `expected exactly one SQL statement, found ${stmts.length}`;
  const stmt = stmts[0]!;
  if (def.category === "write") {
    if (!WRITE_KINDS.has(stmt.kind)) return `write checks must be INSERT, UPDATE, DELETE, or MERGE (found ${stmt.kind})`;
  } else {
    if (!READ_KINDS.has(stmt.kind)) return `${def.category} checks must be a SELECT statement (found ${stmt.kind})`;
    if (stmt.node.intoClause) return "SELECT INTO is not allowed in read checks";
    let modifying = false;
    walk(stmt.node, (tag) => {
      if (tag && WRITE_KINDS.has(tag)) modifying = true;
    });
    if (modifying) return "data-modifying statements (e.g. in a WITH clause) are not allowed in read checks";
  }
  const needed = maxParamNumber(stmt.node);
  if (needed !== def.params.length) {
    return `statement references ${needed} parameter(s) ($1..$${needed}) but ${def.params.length} were configured`;
  }
  return undefined;
}

/** Resolve every check in a project to executable SQL, reading source files from `source`. */
export async function loadFixtures(project: LoadedProject, source: Source): Promise<Map<string, Fixture>> {
  const out = new Map<string, Fixture>();
  for (const def of project.manifest.checks) {
    const file = checkSourcePath(project, def);
    let sql: string | null;
    let origin: FixtureOrigin;
    if (file) {
      sql = await source.readFile(file);
      origin = { kind: "file", path: file, line: 1 };
      if (sql === null) {
        out.set(def.id, { def, sql: "", origin, invalid: `source file not found: ${file}` });
        continue;
      }
    } else {
      sql = def.sql!;
      origin = { kind: "inline", path: project.manifestPath, line: 1 };
    }
    if (origin.kind === "file") origin.line = lineCol(sql, firstTokenOffset(sql)).line;
    const invalid = validateFixtureSql(def, sql);
    out.set(def.id, invalid ? { def, sql, origin, invalid } : { def, sql, origin });
  }
  return out;
}
