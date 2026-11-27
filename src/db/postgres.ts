import { randomBytes } from "node:crypto";
import pg from "pg";
import Cursor from "pg-cursor";

/**
 * Every value is returned as PostgreSQL's own text representation (or null).
 * Nothing is converted through JavaScript numbers or Dates, so numeric
 * precision, timestamps, and formatting are compared exactly.
 */
const RAW_TEXT_TYPES = { getTypeParser: () => (value: string) => value } as unknown as pg.CustomTypesConfig;

export interface DbError {
  code: string | null;
  message: string;
  /** 1-based character position in the statement, when PostgreSQL reports one. */
  position?: number;
  /** True for connection loss, timeouts, cancellations, and other non-SQL failures. */
  infrastructure: boolean;
  timeout: boolean;
}

export interface Column {
  name: string;
  /** Formatted type including modifiers, e.g. `numeric(12,2)`. */
  type: string;
}

export type Row = (string | null)[];

export interface QueryResult {
  columns: Column[];
  rows: Row[];
  /** True when more rows existed than were fetched. */
  truncated: boolean;
  rowCount: number | null;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: DbError };

export function toDbError(err: unknown): DbError {
  const e = err as { code?: string; message?: string; position?: string };
  const code = typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  const timeout = code === "57014";
  const infrastructure = code === null || timeout || code.startsWith("08") || code.startsWith("57P") || code.startsWith("53") || code === "XX000";
  const out: DbError = { code, message: String(e.message ?? err), infrastructure, timeout };
  if (e.position && /^\d+$/.test(e.position)) out.position = Number(e.position);
  return out;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class PgServer {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  async admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: this.url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  }

  async serverVersion(): Promise<number> {
    return this.admin(async (c) => Number((await c.query("SHOW server_version_num")).rows[0].server_version_num));
  }

  static uniqueName(prefix: string): string {
    return `crashpad_${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  }

  async createDatabase(name: string, template?: string): Promise<void> {
    await this.admin((c) =>
      c.query(`CREATE DATABASE ${quoteIdent(name)}${template ? ` TEMPLATE ${quoteIdent(template)}` : " TEMPLATE template0"}`),
    );
  }

  async dropDatabase(name: string): Promise<void> {
    await this.admin((c) => c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`));
  }

  databaseUrl(name: string): string {
    const u = new URL(this.url);
    u.pathname = `/${encodeURIComponent(name)}`;
    return u.toString();
  }

  async connect(name: string): Promise<PgSession> {
    const client = new pg.Client({ connectionString: this.databaseUrl(name), types: RAW_TEXT_TYPES, application_name: "crashpad" });
    await client.connect();
    const session = new PgSession(client);
    await session.init();
    return session;
  }
}

export class PgSession {
  private typeNames = new Map<string, string>();
  readonly client: pg.Client;
  constructor(client: pg.Client) {
    this.client = client;
    // Errors on an idle client must not crash the process; the next query reports them.
    client.on("error", () => {});
  }

  async init(): Promise<void> {
    // Pin output formatting so baseline and candidate render values identically.
    await this.client.query(
      "SET TimeZone = 'UTC'; SET DateStyle = 'ISO, MDY'; SET IntervalStyle = 'postgres'; SET extra_float_digits = 1; SET bytea_output = 'hex'; SET lc_messages = 'C'",
    ).catch(async () => {
      // lc_messages requires superuser on some servers; retry without it.
      await this.client.query("SET TimeZone = 'UTC'; SET DateStyle = 'ISO, MDY'; SET IntervalStyle = 'postgres'; SET extra_float_digits = 1; SET bytea_output = 'hex'");
    });
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => {});
  }

  /** Run a multi-statement script with the simple query protocol (schema, seed, migrations). */
  async runScript(sql: string, timeoutMs: number): Promise<Outcome<null>> {
    try {
      await this.client.query(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      await this.client.query(sql);
      return { ok: true, value: null };
    } catch (err) {
      return { ok: false, error: toDbError(err) };
    } finally {
      await this.client.query("RESET statement_timeout").catch(() => {});
    }
  }

  /**
   * Run pre-split statements of one script inside a single transaction (the same
   * atomicity as a multi-statement simple query), so a failure can be attributed
   * to the exact statement. Error positions are made relative to the whole script.
   */
  async runStatements(stmts: Array<{ text: string; start: number; firstToken: number }>, timeoutMs: number): Promise<Outcome<null>> {
    const c = this.client;
    let current: { start: number; firstToken: number } | null = null;
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      for (const s of stmts) {
        current = s;
        await c.query(s.text);
      }
      current = null;
      await c.query("COMMIT");
      return { ok: true, value: null };
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      const e = toDbError(err);
      if (current) e.position = current.start + (e.position ?? current.firstToken - current.start + 1);
      return { ok: false, error: e };
    }
  }

  private async columns(fields: Array<{ name: string; dataTypeID: number; dataTypeModifier: number }>): Promise<Column[]> {
    const out: Column[] = [];
    for (const f of fields) {
      const key = `${f.dataTypeID}:${f.dataTypeModifier}`;
      let type = this.typeNames.get(key);
      if (!type) {
        const r = await this.client.query("SELECT format_type($1::oid, $2::int) AS t", [f.dataTypeID, f.dataTypeModifier]);
        type = String(r.rows[0].t);
        this.typeNames.set(key, type);
      }
      out.push({ name: f.name, type });
    }
    return out;
  }

  /**
   * Execute one statement inside a transaction that is always rolled back.
   * Reads use a cursor and stop after `maxRows + 1` rows so oversized results
   * are detected without loading them.
   */
  async execute(
    sql: string,
    params: unknown[],
    opts: { readOnly: boolean; maxRows: number; timeoutMs: number; checkDeferred?: boolean },
  ): Promise<Outcome<QueryResult>> {
    const c = this.client;
    try {
      await c.query(opts.readOnly ? "BEGIN READ ONLY" : "BEGIN");
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.timeoutMs))}`);
      const preparedParams = params.map(encodeParam);
      let result: QueryResult;
      if (opts.readOnly) {
        const cursor = c.query(new Cursor(sql, preparedParams, { types: RAW_TEXT_TYPES, rowMode: "array" }));
        const { rows, fields } = await new Promise<{ rows: unknown[][]; fields: any[] }>((resolve, reject) => {
          cursor.read(opts.maxRows + 1, (err, rows, res) => (err ? reject(err) : resolve({ rows: rows as unknown[][], fields: res.fields })));
        });
        await new Promise<void>((resolve) => cursor.close(() => resolve()));
        const truncated = rows.length > opts.maxRows;
        result = {
          columns: await this.columns(fields),
          rows: (truncated ? rows.slice(0, opts.maxRows) : rows) as Row[],
          truncated,
          rowCount: null,
        };
      } else {
        const r = await c.query({ text: sql, values: preparedParams, rowMode: "array", types: RAW_TEXT_TYPES });
        if (opts.checkDeferred !== false) {
          // Deferred constraints would otherwise only fire at COMMIT, which we never reach.
          await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        }
        const truncated = r.rows.length > opts.maxRows;
        result = {
          columns: await this.columns(r.fields ?? []),
          rows: (truncated ? r.rows.slice(0, opts.maxRows) : r.rows) as Row[],
          truncated,
          rowCount: r.rowCount,
        };
      }
      return { ok: true, value: result };
    } catch (err) {
      return { ok: false, error: toDbError(err) };
    } finally {
      await c.query("ROLLBACK").catch(() => {});
    }
  }

  async catalog(): Promise<Catalog> {
    const r = await this.client.query(
      `SELECT c.table_schema, c.table_name, c.column_name
         FROM information_schema.columns c
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1, 2, c.ordinal_position`,
    );
    const cat: Catalog = {};
    for (const row of r.rows as Array<{ table_schema: string; table_name: string; column_name: string }>) {
      const key = `${row.table_schema}.${row.table_name}`;
      (cat[key] ??= []).push(row.column_name);
    }
    return cat;
  }
}

/** `schema.table` → column names, in ordinal order. */
export type Catalog = Record<string, string[]>;

/**
 * JSON parameters are passed as text and typed by PostgreSQL from context, so
 * numeric strings like "12345678901234567.89" keep full precision.
 */
function encodeParam(v: unknown): unknown {
  if (v === null || typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable database url)";
  }
}
