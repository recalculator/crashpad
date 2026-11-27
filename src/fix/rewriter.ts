import type { Catalog } from "../db/postgres.ts";
import { lineCol, parseStatements, scanTokens, SqlParseError, walk, type Node, type Token } from "../sql/parser.ts";
import type { ColumnRename } from "./renames.ts";

export interface RewriteChange {
  kind: "column-ref" | "insert-column" | "update-column" | "output-alias";
  line: number;
  column: number;
  before: string;
  after: string;
}

export type RewriteResult =
  | { status: "changed"; text: string; changes: RewriteChange[] }
  | { status: "unchanged" }
  | { status: "refused"; reason: string };

class Refusal extends Error {}

interface ScopeEntry {
  schema: string;
  table: string;
  refName: string;
  aliased: boolean;
  columns: string[] | undefined;
}

interface Edit {
  start: number;
  end: number;
  text: string;
  kind: RewriteChange["kind"];
}

const SIMPLE_IDENT = /^[a-z_][a-z0-9_$]*$/;

function isReservedWord(name: string): boolean {
  try {
    const toks = scanTokens(name);
    return toks.length === 1 && (toks[0]!.keywordName === "RESERVED_KEYWORD" || toks[0]!.keywordName === "TYPE_FUNC_NAME_KEYWORD");
  } catch {
    return true;
  }
}

/** Identifier text for a column reference position. */
export function columnIdent(name: string): string {
  return SIMPLE_IDENT.test(name) && !isReservedWord(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Identifier text after AS (any keyword is a valid column label there). */
function labelIdent(name: string): string {
  return SIMPLE_IDENT.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function identValue(tok: Token): string | null {
  const t = tok.text;
  if (t.startsWith('"')) return t.endsWith('"') && t.length >= 2 ? t.slice(1, -1).replace(/""/g, '"') : null;
  if (/^u&"/i.test(t)) return null; // Unicode-escaped identifiers: unsupported
  if (!/^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*$/.test(t)) return null;
  return t.toLowerCase();
}

const UNSUPPORTED_NODES: Record<string, string> = {
  SubLink: "subqueries",
  RangeSubselect: "subqueries in FROM",
  CommonTableExpr: "WITH clauses",
  WithClause: "WITH clauses",
  RangeFunction: "functions in FROM",
  RangeTableFunc: "XMLTABLE/JSON_TABLE",
  JsonTable: "JSON_TABLE",
  MergeStmt: "MERGE",
  MultiAssignRef: "multi-column SET assignments",
  OnConflictClause: "ON CONFLICT clauses",
  IntoClause: "SELECT INTO",
};

/**
 * Rewrite references to renamed columns in a single SQL statement, using the
 * PostgreSQL parse tree for scope resolution and the PostgreSQL scanner for
 * exact token spans. Only identifier tokens that the parser attributes to a
 * column of a renamed table are edited; string literals, comments, and
 * parameters are never touched. Output column names are preserved with an
 * alias (`SELECT name` → `SELECT full_name AS name`).
 *
 * `catalog` must describe the schema the statement was written against (the
 * baseline), and is used to resolve unqualified column names.
 */
export function rewriteForRenames(sql: string, renames: ColumnRename[], catalog: Catalog): RewriteResult {
  try {
    const edits = planEdits(sql, renames, catalog);
    if (edits.length === 0) return { status: "unchanged" };
    const text = applyEdits(sql, edits);
    // Self-check: the result must parse, keep the same output names, and contain no
    // remaining references to the old column names under the renamed schema.
    const renamedCatalog = applyRenamesToCatalog(catalog, renames);
    let again: Edit[];
    try {
      again = planEdits(text, renames, renamedCatalog);
    } catch (err) {
      if (err instanceof SqlParseError) return { status: "refused", reason: `internal: rewritten SQL does not parse (${err.message})` };
      throw err;
    }
    if (again.length) return { status: "refused", reason: "internal: rewrite did not converge" };
    const beforeNames = outputNames(sql);
    const afterNames = outputNames(text);
    if (JSON.stringify(beforeNames) !== JSON.stringify(afterNames)) {
      return { status: "refused", reason: `rewrite would change output column names (${beforeNames.join(", ")} → ${afterNames.join(", ")})` };
    }
    const changes = [...edits]
      .sort((a, b) => a.start - b.start)
      .map((e) => {
        const { line, column } = lineCol(sql, e.start);
        return { kind: e.kind, line, column, before: sql.slice(e.start, e.end), after: e.text };
      });
    return { status: "changed", text, changes };
  } catch (err) {
    if (err instanceof Refusal) return { status: "refused", reason: err.message };
    if (err instanceof SqlParseError) return { status: "refused", reason: `SQL does not parse: ${err.message}` };
    throw err;
  }
}

export function applyRenamesToCatalog(catalog: Catalog, renames: ColumnRename[]): Catalog {
  const out: Catalog = {};
  for (const [k, cols] of Object.entries(catalog)) {
    out[k] = cols.map((c) => renames.find((r) => `${r.schema}.${r.table}` === k && r.from === c)?.to ?? c);
  }
  return out;
}

function applyEdits(sql: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.end > sorted[i - 1]!.start) throw new Refusal("internal: overlapping edits");
  }
  let out = sql;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Output column names of a SELECT (or RETURNING list), as PostgreSQL would name simple targets. */
function outputNames(sql: string): string[] {
  const [stmt] = parseStatements(sql);
  if (!stmt) return [];
  const list = (stmt.kind === "SelectStmt" ? stmt.node.targetList : returningList(stmt.node)) as Node[] | undefined;
  return (list ?? []).map((t) => targetName(t.ResTarget as Node) ?? "?column?");
}

function returningList(n: Node): Node[] | undefined {
  return (n.returningClause?.exprs ?? n.returningList) as Node[] | undefined;
}

function targetName(rt: Node): string | null {
  if (rt.name) return rt.name as string;
  let v = rt.val as Node | undefined;
  while (v && (v.TypeCast || v.CollateClause)) v = (v.TypeCast ?? v.CollateClause).arg as Node;
  const cr = v?.ColumnRef as Node | undefined;
  if (cr) {
    const last = (cr.fields as Node[]).at(-1);
    return last?.String ? (last.String.sval as string) : null;
  }
  return null;
}

function planEdits(sql: string, renames: ColumnRename[], catalog: Catalog): Edit[] {
  const stmts = parseStatements(sql);
  if (stmts.length !== 1) throw new Refusal(`expected one statement, found ${stmts.length}`);
  const stmt = stmts[0]!;
  const tokens = scanTokens(sql);
  const tokenAt = new Map<number, number>();
  tokens.forEach((t, i) => tokenAt.set(t.start, i));
  const renamedTables = new Set(renames.map((r) => `${r.schema}.${r.table}`));

  // Relevance: does the statement touch a renamed table at all?
  let touches = false;
  walk(stmt.node, (tag, v, key) => {
    // INSERT/UPDATE/DELETE targets are stored untagged under `relation`.
    if ((tag === "RangeVar" || (tag === null && key === "relation" && typeof v.relname === "string")) && renamedTables.has(`${(v.schemaname as string) ?? "public"}.${v.relname as string}`)) touches = true;
  });
  if (!touches) return [];

  // Refuse constructs whose name-resolution rules we do not model.
  walk(stmt.node, (tag, v, key) => {
    const what = tag ? UNSUPPORTED_NODES[tag] : key === "onConflictClause" ? "ON CONFLICT clauses" : key === "withClause" ? "WITH clauses" : undefined;
    if (what) throw new Refusal(`unsupported nested scope or construct: ${what}`);
    if (tag === "JoinExpr" && (v.usingClause || v.isNatural)) throw new Refusal("unsupported: JOIN … USING / NATURAL JOIN (column names are merged)");
    const insertValues = tag === "SelectStmt" && key === "selectStmt" && stmt.kind === "InsertStmt" && v.valuesLists && !v.fromClause && !v.targetList;
    if (tag === "SelectStmt" && !insertValues) throw new Refusal("unsupported nested scope: nested SELECT or set operation");
  });
  if (stmt.kind === "SelectStmt" && (stmt.node.op && stmt.node.op !== "SETOP_NONE")) throw new Refusal("unsupported: UNION/INTERSECT/EXCEPT");
  if (!["SelectStmt", "InsertStmt", "UpdateStmt", "DeleteStmt"].includes(stmt.kind)) throw new Refusal(`unsupported statement kind ${stmt.kind}`);

  const entry = (rv: Node): ScopeEntry => {
    const schema = (rv.schemaname as string | undefined) ?? "public";
    const table = rv.relname as string;
    const alias = rv.alias?.aliasname as string | undefined;
    if (rv.alias?.colnames) throw new Refusal("unsupported: table alias with column aliases");
    return { schema, table, refName: alias ?? table, aliased: !!alias, columns: catalog[`${schema}.${table}`] };
  };
  const fromItems = (items: Node[] | undefined, out: ScopeEntry[]) => {
    for (const it of items ?? []) {
      if (it.RangeVar) out.push(entry(it.RangeVar as Node));
      else if (it.JoinExpr) fromItems([it.JoinExpr.larg, it.JoinExpr.rarg] as Node[], out);
      else throw new Refusal(`unsupported FROM item ${Object.keys(it)[0]}`);
    }
  };

  const scope: ScopeEntry[] = [];
  const n = stmt.node;
  if (stmt.kind === "SelectStmt") fromItems(n.fromClause as Node[], scope);
  else {
    scope.push(entry(n.relation as Node));
    fromItems((n.fromClause ?? n.usingClause) as Node[] | undefined, scope);
  }
  const names = new Set(scope.map((s) => s.refName));
  if (names.size !== scope.length) throw new Refusal("unsupported: the same table name or alias appears twice in scope");

  const renameFor = (e: ScopeEntry, col: string) => renames.find((r) => r.schema === e.schema && r.table === e.table && r.from === col);
  const scopeMentions = (col: string) => scope.some((e) => renameFor(e, col));

  /** Resolve a ColumnRef to the scope entry it belongs to, if it is a renamed column. */
  const resolve = (cr: Node): { entry: ScopeEntry; rename: ColumnRename; fields: string[] } | null => {
    const fields = cr.fields as Node[];
    if (fields.some((f) => f.A_Star)) {
      const quals = fields.slice(0, -1).map((f) => f.String?.sval as string);
      const covered = quals.length === 0 ? scope : scope.filter((e) => e.refName === quals.at(-1));
      if (covered.some((e) => renames.some((r) => r.schema === e.schema && r.table === e.table))) {
        throw new Refusal("unsupported: * over a table with a renamed column changes the output column names; list columns explicitly");
      }
      return null;
    }
    const parts = fields.map((f) => f.String?.sval as string);
    const col = parts.at(-1)!;
    if (!renames.some((r) => r.from === col)) return null;
    let target: ScopeEntry | undefined;
    if (parts.length === 1) {
      if (!scopeMentions(col)) return null;
      const unknown = scope.filter((e) => !e.columns);
      if (unknown.length) throw new Refusal(`cannot resolve "${col}": ${unknown.map((u) => u.table).join(", ")} not found in the baseline catalog`);
      const owners = scope.filter((e) => e.columns!.includes(col));
      if (owners.length !== 1) throw new Refusal(`ambiguous unqualified column "${col}" (${owners.length} tables in scope have it)`);
      target = owners[0];
    } else if (parts.length === 2) {
      target = scope.find((e) => e.refName === parts[0]);
    } else if (parts.length === 3) {
      target = scope.find((e) => !e.aliased && e.schema === parts[0] && e.table === parts[1]);
    } else {
      throw new Refusal(`unsupported column reference ${parts.join(".")}`);
    }
    if (!target) return null;
    const rename = renameFor(target, col);
    return rename ? { entry: target, rename, fields: parts } : null;
  };

  const edits: Edit[] = [];
  const handled = new Set<Node>();

  /** Locate the identifier chain for a ColumnRef and return the span of its last identifier. */
  const lastIdentSpan = (cr: Node, expected: string[]): { start: number; end: number } => {
    const start = tokenAt.get(cr.location as number);
    if (start === undefined) throw new Refusal("internal: column reference location does not start a token");
    let i = start;
    for (let k = 0; k < expected.length; k++) {
      const tok = tokens[i];
      if (!tok || identValue(tok) !== expected[k]) throw new Refusal(`unsupported identifier spelling near "${tok?.text ?? ""}"`);
      if (k === expected.length - 1) return { start: tok.cstart, end: tok.cend };
      const dot = tokens[i + 1];
      if (!dot || dot.text !== "." || dot.cstart !== tok.cend) throw new Refusal("unsupported: whitespace or comments inside a qualified name");
      i += 2;
      if (tokens[i]?.cstart !== dot.cend) throw new Refusal("unsupported: whitespace or comments inside a qualified name");
    }
    throw new Refusal("internal: empty column reference");
  };

  const renameRef = (cr: Node): { end: number; rename: ColumnRename } | null => {
    const hit = resolve(cr);
    if (!hit) return null;
    const span = lastIdentSpan(cr, hit.fields);
    edits.push({ ...span, text: columnIdent(hit.rename.to), kind: "column-ref" });
    return { end: span.end, rename: hit.rename };
  };

  const renameNamedTarget = (rt: Node, kind: Edit["kind"], e: ScopeEntry) => {
    const rename = renameFor(e, rt.name as string);
    if (!rename) return;
    if (rt.indirection) throw new Refusal(`unsupported: subscripted or field target ${rt.name as string}`);
    const idx = tokenAt.get(rt.location as number);
    const tok = idx === undefined ? undefined : tokens[idx];
    if (!tok || identValue(tok) !== rt.name) throw new Refusal(`internal: target column token not found for ${rt.name as string}`);
    edits.push({ start: tok.cstart, end: tok.cend, text: columnIdent(rename.to), kind });
  };

  /** SELECT lists and RETURNING lists: keep the original output column name. */
  const targets = (list: Node[] | undefined) => {
    for (const t of list ?? []) {
      const rt = t.ResTarget as Node;
      if (!rt.name && rt.val?.ColumnRef) {
        const cr = rt.val.ColumnRef as Node;
        handled.add(cr);
        const r = renameRef(cr);
        if (r) edits.push({ start: r.end, end: r.end, text: ` AS ${labelIdent(r.rename.from)}`, kind: "output-alias" });
      } else if (!rt.name && rt.val && (rt.val.TypeCast || rt.val.CollateClause)) {
        let inner = rt.val as Node;
        while (inner.TypeCast || inner.CollateClause) inner = (inner.TypeCast ?? inner.CollateClause).arg as Node;
        if (inner.ColumnRef && resolve(inner.ColumnRef as Node)) {
          throw new Refusal("unsupported: cast of a renamed column without an explicit alias; add `AS <name>` first");
        }
      }
    }
  };

  const outNames = new Set(((stmt.kind === "SelectStmt" ? n.targetList : returningList(n)) as Node[] | undefined ?? []).map((t) => targetName(t.ResTarget as Node)));

  if (stmt.kind === "SelectStmt") {
    targets(n.targetList as Node[]);
    // ORDER BY and DISTINCT ON resolve a bare name to an output column first.
    for (const item of [...((n.sortClause as Node[]) ?? []).map((s) => s.SortBy?.node as Node), ...((n.distinctClause as Node[]) ?? [])]) {
      const cr = item?.ColumnRef as Node | undefined;
      if (cr && (cr.fields as Node[]).length === 1 && outNames.has((cr.fields as Node[])[0]!.String?.sval as string)) handled.add(cr);
    }
  } else {
    if (stmt.kind === "InsertStmt") {
      const e = scope[0]!;
      for (const c of (n.cols as Node[]) ?? []) renameNamedTarget(c.ResTarget as Node, "insert-column", e);
      const sel = n.selectStmt?.SelectStmt as Node | undefined;
      if (sel && !sel.valuesLists) throw new Refusal("unsupported: INSERT … SELECT");
    }
    if (stmt.kind === "UpdateStmt") {
      for (const t of (n.targetList as Node[]) ?? []) renameNamedTarget(t.ResTarget as Node, "update-column", scope[0]!);
    }
    targets(returningList(n));
  }

  // Every other column reference in the statement (WHERE, JOIN … ON, GROUP BY, HAVING,
  // expressions inside the select list, SET values, …).
  const insertValues = stmt.kind === "InsertStmt" ? (n.selectStmt as Node | undefined) : undefined;
  walk(stmt.kind === "InsertStmt" ? { ...n, selectStmt: undefined } : n, (tag, v) => {
    if (tag === "ColumnRef" && !handled.has(v)) {
      handled.add(v);
      renameRef(v);
    }
  });
  if (insertValues) {
    walk(insertValues.SelectStmt?.valuesLists, (tag, v) => {
      if (tag === "ColumnRef") renameRef(v);
    });
  }
  return edits;
}
