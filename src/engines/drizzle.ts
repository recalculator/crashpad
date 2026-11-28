import fs from "node:fs/promises";
import path from "node:path";
import { PgServer, quoteIdent, toDbError, type PgSession } from "../db/postgres.ts";
import { pgErrorName } from "../db/errors.ts";
import type { Classification } from "../report/types.ts";
import type { Evidence, Finding } from "../suite/types.ts";
import { runCommand } from "./app.ts";
import { buildTestEnv } from "./env.ts";
import { mkFinding } from "./runtime.ts";
import type { CodeTree } from "./trees.ts";

/**
 * Schema compatibility for projects whose PostgreSQL schema is defined in Drizzle ORM
 * code and applied with `drizzle-kit push`, so there is no committed migration history.
 *
 * What it does, per version: `drizzle-kit export` turns the committed schema module into
 * the DDL for an empty database, and that DDL is executed in a disposable database. Then
 * synthetic sample rows (generated from the column types) are written under the BASELINE
 * schema and replayed into the CANDIDATE schema. A row the baseline schema accepts but the
 * candidate rejects is concrete evidence that existing data, or code written for the
 * baseline, would break.
 *
 * What it does NOT do: it does not generate or run the statements that would migrate a real
 * database (`drizzle-kit push` computes those interactively against a live database), it
 * does not test a historical migration sequence, and it never sees production data.
 */

export const SCHEMA_COMPAT_LABEL = "schema compatibility (ORM-derived schemas, not migrations)";

export interface DdlResult {
  ok: boolean;
  sql: string;
  message: string;
  output: string;
  command: string;
}

/** Run the project's own drizzle-kit (from its installed dependencies) to export the DDL of `schemaRel`. */
export async function exportDrizzleDdl(tree: CodeTree, schemaRel: string, timeoutMs: number, signal?: AbortSignal): Promise<DdlResult> {
  const bin = path.join(tree.appDir, "node_modules", ".bin", "drizzle-kit");
  const argv = [bin, "export", "--dialect", "postgresql", "--schema", schemaRel];
  const command = `drizzle-kit export --dialect postgresql --schema ${schemaRel}`;
  if (!(await fs.stat(bin).catch(() => null))) return { ok: false, sql: "", command, output: "", message: "drizzle-kit is not installed in this version's dependencies (it is normally a devDependency); the schema cannot be exported" };
  // No application variables: exporting a schema must not need secrets or a database.
  const env = buildTestEnv({ schema: null, useExampleValues: false, explicit: {}, generated: {} }).env;
  const r = await runCommand(argv, { cwd: tree.projectDir, env, timeoutMs, captureStdout: true, ...(signal ? { signal } : {}) });
  const sql = (r.stdout ?? "").trim();
  if (!r.ok) return { ok: false, sql: "", command, output: r.output, message: `\`${command}\` failed (${r.timedOut ? "timed out" : `exit ${r.code}`})` };
  if (!/\bCREATE\s+(TABLE|TYPE|SCHEMA)\b/i.test(sql)) return { ok: false, sql, command, output: r.output, message: `\`${command}\` produced no CREATE statements; is ${schemaRel} the schema module?` };
  return { ok: true, sql, command, output: r.output, message: "exported" };
}

// ---------------------------------------------------------------------------
// Catalog

interface Col {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  identity: string;
  generated: string;
  typtype: string;
  typname: string;
  elemTyptype: string | null;
  enumLabels: string[] | null;
  maxLen: number | null;
}

interface Fk {
  table: string;
  cols: string[];
  refTable: string;
  refCols: string[];
}

export interface SchemaCatalog {
  tables: Map<string, Col[]>;
  enums: Map<string, string[]>;
  fks: Fk[];
}

const display = (key: string) => (key.startsWith("public.") ? key.slice(7) : key);

export async function readCatalog(s: PgSession): Promise<SchemaCatalog> {
  const c = s.client;
  const enums = new Map<string, string[]>();
  const er = await c.query(
    `SELECT n.nspname || '.' || t.typname AS name, e.enumlabel AS label
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
      ORDER BY 1, e.enumsortorder`,
  );
  for (const r of er.rows as Array<{ name: string; label: string }>) (enums.get(r.name) ?? enums.set(r.name, []).get(r.name)!).push(r.label);
  const cr = await c.query(
    `SELECT n.nspname || '.' || cl.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity AS identity, a.attgenerated AS generated,
            t.typtype, tn.nspname || '.' || t.typname AS typname, et.typtype AS elem_typtype,
            CASE WHEN a.atttypmod > 4 AND t.typname IN ('varchar', 'bpchar') THEN a.atttypmod - 4 END AS maxlen
       FROM pg_class cl
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
       JOIN pg_type t ON t.oid = a.atttypid
       JOIN pg_namespace tn ON tn.oid = t.typnamespace
       LEFT JOIN pg_type et ON et.oid = t.typelem AND t.typcategory = 'A'
       LEFT JOIN pg_attrdef d ON d.adrelid = cl.oid AND d.adnum = a.attnum
      WHERE cl.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY 1, a.attnum`,
  );
  const tables = new Map<string, Col[]>();
  for (const r of cr.rows as any[]) {
    const col: Col = {
      name: r.name,
      type: r.type,
      notNull: r.notnull === true || r.notnull === "t",
      default: r.def ?? null,
      identity: r.identity ?? "",
      generated: r.generated ?? "",
      typtype: r.typtype,
      typname: r.typname,
      elemTyptype: r.elem_typtype ?? null,
      enumLabels: r.typtype === "e" ? (enums.get(r.typname) ?? []) : null,
      maxLen: r.maxlen === null || r.maxlen === undefined ? null : Number(r.maxlen),
    };
    (tables.get(r.tbl) ?? tables.set(r.tbl, []).get(r.tbl)!).push(col);
  }
  const fr = await c.query(
    `SELECT con.conrelid::regclass::text AS tbl, cn.nspname AS tns, con.confrelid::regclass::text AS ref, rn.nspname AS rns,
            ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text AS cols,
            ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i)::text AS refcols
       FROM pg_constraint con
       JOIN pg_class c1 ON c1.oid = con.conrelid JOIN pg_namespace cn ON cn.oid = c1.relnamespace
       JOIN pg_class c2 ON c2.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = c2.relnamespace
      WHERE con.contype = 'f'`,
  );
  const arr = (t: string) => t.replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((x) => x.replace(/^"|"$/g, ""));
  const qualify = (name: string, ns: string) => `${ns}.${name.includes(".") ? name.split(".").pop()!.replace(/^"|"$/g, "") : name.replace(/^"|"$/g, "")}`;
  const fks = (fr.rows as any[]).map((r) => ({ table: qualify(r.tbl, r.tns), cols: arr(r.cols), refTable: qualify(r.ref, r.rns), refCols: arr(r.refcols) }));
  return { tables, enums, fks };
}

/** Parent tables before children; tables in reference cycles keep their relative order at the end. */
export function insertionOrder(cat: SchemaCatalog): string[] {
  const names = [...cat.tables.keys()].sort();
  const deps = new Map(names.map((n) => [n, new Set(cat.fks.filter((f) => f.table === n && f.refTable !== n).map((f) => f.refTable))]));
  const out: string[] = [];
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of names) {
      if (done.has(n)) continue;
      if ([...deps.get(n)!].every((d) => done.has(d) || !cat.tables.has(d))) {
        out.push(n);
        done.add(n);
        progress = true;
      }
    }
  }
  for (const n of names) if (!done.has(n)) out.push(n);
  return out;
}

// ---------------------------------------------------------------------------
// Synthetic sample rows

/** A deterministic sample value for column `c` in row `k` (1-based), or undefined if the type is not supported. */
export function sampleValue(c: Col, k: number): string | undefined {
  if (c.typtype === "e") return c.enumLabels?.length ? c.enumLabels[(k - 1) % c.enumLabels.length] : undefined;
  if (c.type.endsWith("[]")) return "{}";
  const t = c.type.replace(/\(.*\)/, "").trim();
  const fit = (s: string) => (c.maxLen ? s.slice(0, c.maxLen) : s);
  switch (t) {
    case "text":
    case "character varying":
    case "character":
    case "citext":
    case "name":
      return fit(`sample-${k}`);
    case "smallint":
    case "integer":
    case "bigint":
    case "numeric":
    case "real":
    case "double precision":
      return String(k);
    case "boolean":
      return k % 2 ? "true" : "false";
    case "uuid":
      return `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
    case "timestamp with time zone":
    case "timestamp without time zone":
      return `2026-01-0${Math.min(k, 9)} 12:00:00${t.includes("with time zone") ? "+00" : ""}`;
    case "date":
      return `2026-01-0${Math.min(k, 9)}`;
    case "time without time zone":
    case "time with time zone":
      return "12:00:00";
    case "interval":
      return `${k} days`;
    case "json":
    case "jsonb":
      return "{}";
    case "bytea":
      return "\\x00";
    case "inet":
      return `127.0.0.${k}`;
    case "cidr":
      return "10.0.0.0/8";
  }
  return undefined;
}

type Row = Record<string, string | null>;

interface TableSamples {
  table: string;
  rows: Row[];
  /** Why no sample could be written under the baseline schema. */
  problem?: string;
}

/**
 * Write two rows per table under the baseline schema: a "full" row (every column
 * without a default gets a value) and a "minimal" row (only NOT NULL columns without
 * a default). Defaults, identity, and generated columns are left to PostgreSQL, then
 * the stored rows are read back exactly as a migrated database would hold them.
 */
export async function writeSamples(s: PgSession, cat: SchemaCatalog): Promise<TableSamples[]> {
  const out: TableSamples[] = [];
  const stored = new Map<string, Row[]>();
  for (const table of insertionOrder(cat)) {
    const cols = cat.tables.get(table)!;
    const fks = cat.fks.filter((f) => f.table === table);
    const ts: TableSamples = { table, rows: [] };
    out.push(ts);
    for (const k of [1, 2]) {
      const minimal = k === 2;
      const names: string[] = [];
      const values: (string | null)[] = [];
      let unsupported: string | null = null;
      for (const c of cols) {
        if (c.generated || c.identity === "a") continue;
        if (c.default !== null || c.identity) continue;
        if (minimal && !c.notNull) continue;
        const fk = fks.find((f) => f.cols.includes(c.name));
        let v: string | null | undefined;
        if (fk) {
          const parent = fk.refTable === table ? null : stored.get(fk.refTable)?.[k - 1] ?? stored.get(fk.refTable)?.[0];
          v = parent ? parent[fk.refCols[fk.cols.indexOf(c.name)]!] ?? null : null;
          if (v === null && c.notNull) {
            unsupported = fk.refTable === table ? `column ${c.name} is a NOT NULL reference to its own table` : `no ${display(fk.refTable)} row to reference from ${c.name}`;
            break;
          }
        } else v = sampleValue(c, k);
        if (v === undefined) {
          unsupported = `column ${c.name} has type ${c.type}, for which Crashpad cannot generate a sample value`;
          break;
        }
        names.push(c.name);
        values.push(v);
      }
      if (unsupported) {
        ts.problem ??= unsupported;
        continue;
      }
      const [schema, rel] = table.split(".") as [string, string];
      const target = `${quoteIdent(schema)}.${quoteIdent(rel)}`;
      const sql = names.length
        ? `INSERT INTO ${target} (${names.map(quoteIdent).join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${cols.map((c) => `${quoteIdent(c.name)}::text`).join(", ")}`
        : `INSERT INTO ${target} DEFAULT VALUES RETURNING ${cols.map((c) => `${quoteIdent(c.name)}::text`).join(", ")}`;
      try {
        const r = await s.client.query({ text: sql, values, rowMode: "array" });
        const row: Row = {};
        cols.forEach((c, i) => (row[c.name] = (r.rows[0] as (string | null)[])[i] ?? null));
        ts.rows.push(row);
        (stored.get(table) ?? stored.set(table, []).get(table)!).push(row);
      } catch (err) {
        const e = toDbError(err);
        ts.problem ??= `a synthetic ${minimal ? "minimal" : "full"} row was rejected by the baseline schema itself (${pgErrorName(e.code)}: ${e.message})`;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison

const WIDENING: Array<[RegExp, RegExp]> = [
  [/^smallint$/, /^(integer|bigint|numeric)$/],
  [/^integer$/, /^(bigint|numeric)$/],
  [/^bigint$/, /^numeric$/],
  [/^character varying\(\d+\)$/, /^(text|character varying)$/],
  [/^character varying$/, /^text$/],
  [/^json$/, /^jsonb$/],
];

function typeChange(b: Col, c: Col): "same" | "widened" | "changed" {
  if (b.type === c.type) return "same";
  if (b.typtype === "e" && c.typtype === "e" && b.typname === c.typname) return "same";
  const vb = b.type.match(/^character varying\((\d+)\)$/);
  const vc = c.type.match(/^character varying\((\d+)\)$/);
  if (vb && vc && Number(vc[1]) >= Number(vb[1])) return "widened";
  return WIDENING.some(([from, to]) => from.test(b.type) && to.test(c.type)) ? "widened" : "changed";
}

export interface CompatInput {
  schemaPath: string;
  base: SchemaCatalog;
  cand: SchemaCatalog;
  samples: TableSamples[];
  candSession: PgSession;
}

export interface CompatResult {
  findings: Finding[];
  replayed: number;
  newTables: string[];
}

export async function compareSchemas(i: CompatInput): Promise<CompatResult> {
  const findings: Finding[] = [];
  const failedTables = new Set<string>();
  let replayed = 0;
  const f = (id: string, title: string, cls: Classification, reason: string, message: string, b: Finding["baseline"], c: Finding["candidate"], evidence: Evidence[], operation: string) =>
    mkFinding("database", id, "schema", title, cls, reason, message, b, c, evidence, false, { file: i.schemaPath, operation });

  // Enums: a removed label rejects every stored value that uses it.
  for (const [name, labels] of i.base.enums) {
    const now = i.cand.enums.get(name);
    const removed = now ? labels.filter((l) => !now.includes(l)) : labels;
    const usedByCandidate = [...i.cand.tables.values()].some((cols) => cols.some((c) => c.typname === name));
    if (!now && !usedByCandidate) continue; // the type and its columns went away; the table findings say so
    if (!removed.length) {
      findings.push(f(`schema:enum:${display(name)}`, `Enum ${display(name)}`, "pass", "ok", `Every baseline value is still accepted (${labels.length} value(s))`, { status: "pass", summary: labels.join(", ") }, { status: "pass", summary: now!.join(", ") }, [], display(name)));
    } else {
      findings.push(f(`schema:enum:${display(name)}`, `Enum ${display(name)}`, "regression", "enum-value-removed", `Enum value(s) ${removed.map((l) => `'${l}'`).join(", ")} exist at the baseline but not in the candidate schema: stored rows with ${removed.length === 1 ? "that value" : "those values"} cannot be represented, and baseline code that writes ${removed.length === 1 ? "it" : "them"} would fail`, { status: "pass", summary: labels.join(", ") }, { status: "fail", summary: now ? now.join(", ") : "type removed" }, [{ kind: "diff", label: "enum values", detail: removed.map((l) => `- ${l}`).join("\n") }], display(name)));
    }
  }

  for (const ts of i.samples) {
    const name = display(ts.table);
    const bcols = i.base.tables.get(ts.table)!;
    const ccols = i.cand.tables.get(ts.table);
    const id = `schema:table:${name}`;
    const title = `Table ${name}`;
    if (!ccols) {
      failedTables.add(ts.table);
      findings.push(f(id, title, "regression", "table-dropped", `Table ${name} exists at the baseline but not in the candidate schema: its rows would have nowhere to go (a rename also looks like this; ORM definitions do not record renames)`, { status: "pass", summary: `${bcols.length} column(s)` }, { status: "fail", summary: "table removed" }, [], name));
      continue;
    }
    const diff: string[] = [];
    const dropped = bcols.filter((b) => !ccols.some((c) => c.name === b.name)).map((b) => b.name);
    for (const d of dropped) diff.push(`- column ${d} (dropped: its values would be lost)`);
    const changed: string[] = [];
    for (const b of bcols) {
      const c = ccols.find((x) => x.name === b.name);
      if (!c) continue;
      const t = typeChange(b, c);
      if (t !== "same") {
        diff.push(`~ column ${b.name}: ${b.type} → ${c.type}${t === "widened" ? " (widened)" : ""}`);
        if (t === "changed") changed.push(b.name);
      }
      if (!b.notNull && c.notNull) diff.push(`~ column ${b.name}: nullable → NOT NULL${c.default === null ? " (no default)" : ` (default ${c.default})`}`);
      if (b.default !== null && c.default === null && c.notNull && !c.identity && !c.generated) diff.push(`~ column ${b.name}: default ${b.default} removed`);
    }
    for (const c of ccols) {
      if (bcols.some((b) => b.name === c.name)) continue;
      const required = c.notNull && c.default === null && !c.identity && !c.generated;
      diff.push(`+ column ${c.name} ${c.type}${required ? " NOT NULL without a default" : c.notNull ? ` NOT NULL DEFAULT ${c.default ?? "(identity/generated)"}` : ""}`);
    }
    const evidence: Evidence[] = diff.length ? [{ kind: "diff", label: "schema changes (baseline → candidate)", detail: diff.join("\n") }] : [];
    if (ts.problem && !ts.rows.length) {
      findings.push(f(id, title, "inconclusive", "no-sample", `Could not write a sample row under the baseline schema, so compatibility was not tested: ${ts.problem}`, { status: "invalid", summary: ts.problem }, { status: "not-run", summary: "not tested" }, evidence, name));
      failedTables.add(ts.table);
      continue;
    }
    // Replay each stored baseline row into the candidate schema (only the columns that still exist).
    const keep = bcols.filter((b) => ccols.some((c) => c.name === b.name && !c.generated));
    const overriding = keep.some((b) => ccols.find((c) => c.name === b.name)!.identity === "a") ? " OVERRIDING SYSTEM VALUE" : "";
    const [schema, rel] = ts.table.split(".") as [string, string];
    const errors: string[] = [];
    let firstCode: string | null = null;
    let blockedBy: string | null = null;
    for (const [n, row] of ts.rows.entries()) {
      const sql = keep.length
        ? `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(rel)} (${keep.map((c) => quoteIdent(c.name)).join(", ")})${overriding} VALUES (${keep.map((_, j) => `$${j + 1}`).join(", ")})`
        : `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(rel)} DEFAULT VALUES`;
      try {
        await i.candSession.client.query({ text: sql, values: keep.map((c) => row[c.name] ?? null) });
        replayed++;
      } catch (err) {
        const e = toDbError(err);
        const parent = e.code === "23503" ? i.cand.fks.find((fk) => fk.table === ts.table && failedTables.has(fk.refTable)) : undefined;
        if (parent) blockedBy = display(parent.refTable);
        else {
          if (!errors.length) firstCode = e.code;
          errors.push(`${n === 0 ? "full" : "minimal"} sample row: ${pgErrorName(e.code)}${e.code ? ` (${e.code})` : ""}: ${e.message}`);
        }
      }
    }
    if (errors.length) {
      // So that tables referencing this one can still be tested, store stand-in rows: the
      // baseline row plus sample values for whatever the candidate newly requires. They only
      // unblock children; this table's finding stays a regression.
      for (const row of ts.rows) {
        const extra = ccols.filter((c) => c.notNull && c.default === null && !c.identity && !c.generated && (!keep.some((k) => k.name === c.name) || row[c.name] === null));
        const vals = new Map<string, string | null>(keep.map((c) => [c.name, row[c.name] ?? null]));
        for (const c of extra) {
          const v = sampleValue(c, 1);
          if (v !== undefined) vals.set(c.name, v);
        }
        const names = [...vals.keys()];
        try {
          await i.candSession.client.query({ text: `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(rel)} (${names.map(quoteIdent).join(", ")})${overriding} VALUES (${names.map((_, j) => `$${j + 1}`).join(", ")})`, values: [...vals.values()] });
        } catch {
          failedTables.add(ts.table);
        }
      }
    }
    const sampleEv: Evidence = { kind: "sql", side: "baseline", label: "sample rows stored under the baseline schema (synthetic)", detail: ts.rows.map((r) => JSON.stringify(Object.fromEntries(keep.map((c) => [c.name, r[c.name] ?? null])))).join("\n") };
    if (errors.length) {
      findings.push(f(id, title, "regression", pgErrorName(firstCode), `A row that is valid under the baseline schema is rejected by the candidate schema (${errors[0]!.replace(/^[a-z]+ sample row: /, "")}). Rows already stored in a database at the baseline, and inserts written for the baseline schema, would hit the same error.`, { status: "pass", summary: `${ts.rows.length} sample row(s) stored` }, { status: "fail", summary: errors[0]!.replace(/^[a-z]+ sample row: /, "") }, [{ kind: "sql", side: "candidate", label: "PostgreSQL error", detail: errors.join("\n") }, ...evidence, sampleEv], name));
      continue;
    }
    if (blockedBy) {
      failedTables.add(ts.table);
      findings.push(f(id, title, "inconclusive", "parent-rejected", `Not decided: its sample rows reference ${blockedBy}, whose rows the candidate schema rejected (see that finding)`, { status: "pass", summary: `${ts.rows.length} sample row(s) stored` }, { status: "not-run", summary: `blocked by ${blockedBy}` }, evidence, name));
      continue;
    }
    if (dropped.length) {
      findings.push(f(id, title, "regression", "column-dropped", `Column(s) ${dropped.join(", ")} exist at the baseline but not in the candidate schema: their stored values would be lost (a rename also looks like this; ORM definitions do not record renames)`, { status: "pass", summary: `${bcols.length} column(s)` }, { status: "fail", summary: `dropped: ${dropped.join(", ")}` }, [...evidence, sampleEv], name));
      continue;
    }
    if (changed.length) {
      findings.push(f(id, title, "inconclusive", "type-changed", `Column type(s) changed for ${changed.join(", ")}. The synthetic sample values still fit, but real stored values may not convert; review the change`, { status: "pass", summary: `${ts.rows.length} sample row(s) stored` }, { status: "pass", summary: "sample rows accepted" }, [...evidence, sampleEv], name));
      continue;
    }
    findings.push(f(id, title, "pass", "ok", `${ts.rows.length} sample row(s) written under the baseline schema are accepted by the candidate schema${ts.problem ? ` (one sample could not be generated: ${ts.problem})` : ""}`, { status: "pass", summary: `${ts.rows.length} sample row(s) stored` }, { status: "pass", summary: diff.length ? `accepted (${diff.length} compatible change(s))` : "accepted (unchanged)" }, evidence, name));
  }
  const newTables = [...i.cand.tables.keys()].filter((t) => !i.base.tables.has(t)).map(display);
  return { findings, replayed, newTables };
}

// ---------------------------------------------------------------------------
// Orchestration

export interface SchemaCompatSide {
  tree: CodeTree;
}

export interface SchemaCompatResult {
  findings: Finding[];
  ran: string[];
  missing: string[];
  unavailable: string[];
  /** DDL per version, for building runtime databases. Null when that version's DDL could not be exported. */
  ddl: { base: string | null; cand: string | null; candFailed: boolean };
}

export async function runSchemaCompat(o: {
  server: PgServer;
  schemaPath: string;
  /** The schema module relative to the project directory (what drizzle-kit gets). */
  schemaRel: string;
  base: CodeTree;
  cand: CodeTree;
  timeoutMs: number;
  keep?: boolean;
  signal?: AbortSignal;
  log?: (m: string) => void;
}): Promise<SchemaCompatResult> {
  const log = o.log ?? (() => {});
  const res: SchemaCompatResult = { findings: [], ran: [], missing: [], unavailable: [], ddl: { base: null, cand: null, candFailed: false } };
  const what = `${o.schemaPath} (Drizzle ORM)`;
  const ddlFinding = (cls: Classification, reason: string, message: string, b: Finding["baseline"], c: Finding["candidate"], ev: Evidence[]) =>
    res.findings.push(mkFinding("database", "schema:ddl", "schema", `Schema derived from ${o.schemaPath} creates cleanly`, cls, reason, message, b, c, ev, false, { file: o.schemaPath, operation: "drizzle-kit export" }));
  for (const t of [o.base, o.cand]) if (t.problem) res.unavailable.push(`${t.which}: ${t.problem}`);
  if (o.base.problem || o.cand.problem) return res;

  log(`database: exporting ${what} with drizzle-kit (baseline and candidate)`);
  const bd = await exportDrizzleDdl(o.base, o.schemaRel, o.timeoutMs, o.signal);
  const cd = await exportDrizzleDdl(o.cand, o.schemaRel, o.timeoutMs, o.signal);
  if (!bd.ok) {
    res.unavailable.push(`baseline: ${bd.message}`);
    ddlFinding("inconclusive", "baseline-export-failed", `The baseline schema could not be exported, so nothing can be compared: ${bd.message}`, { status: "invalid", summary: bd.message }, { status: cd.ok ? "pass" : "fail", summary: cd.ok ? "exported" : cd.message }, [{ kind: "log", side: "baseline", label: bd.command, detail: bd.output.slice(-3000) || "(no output)" }]);
    res.ddl = { base: null, cand: cd.ok ? cd.sql : null, candFailed: !cd.ok };
    return res;
  }
  res.ddl.base = bd.sql;
  if (!cd.ok) {
    res.ddl.candFailed = true;
    ddlFinding("regression", "export-failed", `The candidate's schema module no longer exports: ${cd.message}`, { status: "pass", summary: "exported" }, { status: "fail", summary: cd.message }, [{ kind: "log", side: "candidate", label: cd.command, detail: cd.output.slice(-3000) || "(no output)" }]);
    return res;
  }
  res.ddl.cand = cd.sql;

  const bName = PgServer.uniqueName("scb");
  const cName = PgServer.uniqueName("scc");
  const sessions: PgSession[] = [];
  try {
    await o.server.createDatabase(bName);
    await o.server.createDatabase(cName);
    const bs = await o.server.connect(bName);
    sessions.push(bs);
    const cs = await o.server.connect(cName);
    sessions.push(cs);
    const br = await bs.runScript(bd.sql, o.timeoutMs);
    if (!br.ok) {
      res.unavailable.push(`the baseline schema does not create on PostgreSQL: ${pgErrorName(br.error.code)}: ${br.error.message}`);
      ddlFinding("baseline-failure", "baseline-ddl-failed", `The baseline schema itself does not create on PostgreSQL (${pgErrorName(br.error.code)}: ${br.error.message}), so the change cannot be compared`, { status: "fail", summary: br.error.message }, { status: "not-run", summary: "not compared" }, []);
      return res;
    }
    const cr = await cs.runScript(cd.sql, o.timeoutMs);
    if (!cr.ok) {
      res.ddl.candFailed = true;
      ddlFinding("regression", pgErrorName(cr.error.code), `The candidate schema does not create on an empty PostgreSQL database: ${pgErrorName(cr.error.code)}: ${cr.error.message}`, { status: "pass", summary: "created" }, { status: "fail", summary: cr.error.message }, [{ kind: "sql", side: "candidate", label: "PostgreSQL error", detail: `${cr.error.code ?? ""} ${cr.error.message}` }, { kind: "sql", side: "candidate", label: "exported DDL", detail: cd.sql.slice(0, 3000) }]);
      return res;
    }
    ddlFinding("pass", "ok", "The candidate schema creates on an empty PostgreSQL database", { status: "pass", summary: "created" }, { status: "pass", summary: "created" }, []);
    const bcat = await readCatalog(bs);
    const ccat = await readCatalog(cs);
    log("database: writing synthetic baseline rows and replaying them into the candidate schema");
    const samples = await writeSamples(bs, bcat);
    const cmp = await compareSchemas({ schemaPath: o.schemaPath, base: bcat, cand: ccat, samples, candSession: cs });
    res.findings.push(...cmp.findings);
    res.ran.push(`${SCHEMA_COMPAT_LABEL}: baseline and candidate schemas exported from ${o.schemaPath} with the project's drizzle-kit and created in disposable PostgreSQL databases`);
    res.ran.push(`${samples.reduce((n, s) => n + s.rows.length, 0)} synthetic sample row(s) written under the baseline schema across ${bcat.tables.size} table(s); ${cmp.replayed} accepted by the candidate schema${cmp.newTables.length ? `; new table(s): ${cmp.newTables.join(", ")}` : ""}`);
    res.missing.push(
      "no committed migrations: how an existing database would be migrated (for example by `drizzle-kit push`) was neither generated nor executed, and no migration sequence was verified",
      "sample rows are synthetic (two per table, generated from column types), not production data; data-dependent problems such as duplicates under a new unique constraint are not detected",
      "the application's own queries are not exercised by this area; read/write/assertion checks (crashpad.checks.json) need SQL migrations",
    );
    return res;
  } catch (err) {
    res.unavailable.push(`schema compatibility could not run: ${(err as Error).message}`);
    return res;
  } finally {
    for (const s of sessions) await s.close();
    if (!o.keep) {
      await o.server.dropDatabase(bName).catch(() => {});
      await o.server.dropDatabase(cName).catch(() => {});
    }
  }
}
