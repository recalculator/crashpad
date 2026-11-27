import { loadModule, parseSync, scanSync, type ScanToken } from "libpg-query";

let loaded: Promise<void> | null = null;

/** libpg-query is the real PostgreSQL parser compiled to WASM; it must be loaded once. */
export function ensureParser(): Promise<void> {
  loaded ??= loadModule();
  return loaded;
}

// The parse tree is a deeply nested tagged union; we walk it generically.
export type Node = Record<string, any>;

export interface ParsedStatement {
  /** e.g. "SelectStmt" */
  kind: string;
  node: Node;
  /** Character offsets of the statement within the input text. */
  start: number;
  end: number;
}

export class SqlParseError extends Error {
  override name = "SqlParseError";
  readonly position: number | undefined;
  constructor(message: string, position?: number) {
    super(message);
    this.position = position;
  }
}

/**
 * Maps UTF-8 byte offsets (used by the PostgreSQL parser and scanner) to
 * JavaScript string indices (UTF-16 code units).
 */
export class OffsetMap {
  private byteToChar: Int32Array;
  readonly byteLength: number;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
    const bytes = Buffer.byteLength(text, "utf8");
    this.byteLength = bytes;
    this.byteToChar = new Int32Array(bytes + 1).fill(-1);
    let b = 0;
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!;
      this.byteToChar[b] = i;
      const units = cp > 0xffff ? 2 : 1;
      b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      i += units;
    }
    this.byteToChar[bytes] = text.length;
  }
  char(byteOffset: number): number {
    const c = this.byteToChar[byteOffset];
    if (c === undefined || c < 0) throw new Error(`byte offset ${byteOffset} is not a character boundary`);
    return c;
  }
}

export function parseStatements(sql: string): ParsedStatement[] {
  let result;
  try {
    result = parseSync(sql);
  } catch (err) {
    const e = err as Error & { sqlDetails?: { cursorPosition?: number } };
    throw new SqlParseError(e.message, e.sqlDetails?.cursorPosition);
  }
  const map = new OffsetMap(sql);
  const stmts = (result.stmts ?? []) as Array<{ stmt: Node; stmt_location?: number; stmt_len?: number }>;
  return stmts.map((s) => {
    const kind = Object.keys(s.stmt)[0]!;
    const startB = s.stmt_location ?? 0;
    const endB = s.stmt_len ? startB + s.stmt_len : map.byteLength;
    return { kind, node: s.stmt[kind] as Node, start: map.char(startB), end: map.char(endB) };
  });
}

export interface Token extends ScanToken {
  /** Character (not byte) offsets. */
  cstart: number;
  cend: number;
}

export function scanTokens(sql: string): Token[] {
  const map = new OffsetMap(sql);
  return scanSync(sql).tokens.map((t) => ({ ...t, cstart: map.char(t.start), cend: map.char(t.end) }));
}

/** Visit every object node in a parse tree, with its tag (e.g. "ColumnRef") when wrapped. */
export function walk(node: unknown, visit: (tag: string | null, value: Node, parentKey: string | null) => boolean | void, parentKey: string | null = null): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, parentKey);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Node;
  const keys = Object.keys(obj);
  // Tagged wrapper: { ColumnRef: {...} }
  if (keys.length === 1 && /^[A-Z]/.test(keys[0]!) && obj[keys[0]!] && typeof obj[keys[0]!] === "object") {
    const tag = keys[0]!;
    const inner = obj[tag] as Node;
    if (visit(tag, inner, parentKey) === false) return;
    for (const k of Object.keys(inner)) walk(inner[k], visit, k);
    return;
  }
  if (visit(null, obj, parentKey) === false) return;
  for (const k of keys) walk(obj[k], visit, k);
}

/** Highest `$n` parameter number referenced in the statement (0 if none). */
export function maxParamNumber(node: Node): number {
  let max = 0;
  walk(node, (tag, v) => {
    if (tag === "ParamRef" && typeof v.number === "number") max = Math.max(max, v.number);
  });
  return max;
}

/** 1-based line and column for a character offset. */
export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

/** Offset of the first token in the text (skipping whitespace and comments). */
export function firstTokenOffset(sql: string): number {
  try {
    const t = scanTokens(sql).find((tok) => tok.tokenName !== "SQL_COMMENT" && tok.tokenName !== "C_COMMENT");
    return t ? t.cstart : 0;
  } catch {
    return 0;
  }
}

/** Statements that cannot run inside a transaction block or that manage transactions themselves. */
const NON_TRANSACTIONAL = new Set(["TransactionStmt", "VacuumStmt", "CreatedbStmt", "DropdbStmt", "AlterSystemStmt", "CreateTableSpaceStmt", "DropTableSpaceStmt", "ReindexStmt", "ClusterStmt"]);

/**
 * Split a script into statements for per-statement execution, or return null when it
 * must run as one unit (it does not parse, controls transactions, or uses CONCURRENTLY).
 */
export function splitScript(sql: string): Array<{ text: string; start: number; firstToken: number }> | null {
  let stmts: ParsedStatement[];
  try {
    stmts = parseStatements(sql);
  } catch {
    return null;
  }
  for (const s of stmts) {
    if (NON_TRANSACTIONAL.has(s.kind)) return null;
    if ((s.kind === "IndexStmt" || s.kind === "DropStmt") && s.node.concurrent) return null;
  }
  return stmts.map((s) => {
    const text = sql.slice(s.start, s.end);
    return { text, start: s.start, firstToken: s.start + firstTokenOffset(text) };
  });
}
