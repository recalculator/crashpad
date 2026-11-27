import type { MigrationFile } from "../migrations.ts";
import { parseStatements, SqlParseError, type Node } from "../sql/parser.ts";

/** An explicit `ALTER TABLE … RENAME COLUMN from TO to` found in a new migration. */
export interface ColumnRename {
  schema: string;
  table: string;
  from: string;
  to: string;
  migration: string;
}

export interface RenameAnalysis {
  renames: ColumnRename[];
  /** Reasons the renames cannot be applied mechanically. Any refusal disables the fixer. */
  refusals: string[];
}

const tableKey = (schema: string, table: string) => `${schema}.${table}`;

/**
 * Only explicit RENAME COLUMN statements count as renames. A drop-and-add, a copy
 * via UPDATE, or a view change is not treated as a rename because its intended
 * semantics cannot be established from the migration alone.
 */
export function detectRenames(added: MigrationFile[]): RenameAnalysis {
  const renames: ColumnRename[] = [];
  const refusals: string[] = [];
  for (const m of added) {
    let stmts;
    try {
      stmts = parseStatements(m.sql);
    } catch (err) {
      if (err instanceof SqlParseError) {
        refusals.push(`${m.path}: migration does not parse (${err.message}); cannot analyze renames`);
        continue;
      }
      throw err;
    }
    for (const s of stmts) {
      const n = s.node as Node;
      if (s.kind === "RenameStmt") {
        const rel = n.relation as Node | undefined;
        const schema = (rel?.schemaname as string | undefined) ?? "public";
        const table = rel?.relname as string | undefined;
        if (n.renameType === "OBJECT_COLUMN" && n.relationType === "OBJECT_TABLE" && table) {
          const from = n.subname as string;
          const to = n.newname as string;
          const key = tableKey(schema, table);
          if (renames.some((r) => tableKey(r.schema, r.table) === key && (r.to === from || r.from === from || r.to === to))) {
            refusals.push(`${m.path}: column ${key}.${from} is renamed more than once or chained; intended final name is ambiguous`);
            continue;
          }
          renames.push({ schema, table, from, to, migration: m.path });
        } else if (n.renameType === "OBJECT_TABLE" || n.renameType === "OBJECT_SCHEMA") {
          if (table && renames.some((r) => r.table === table)) {
            refusals.push(`${m.path}: table ${table} is renamed in the same change as one of its columns; not supported`);
          }
        }
      } else if (s.kind === "AlterTableStmt") {
        const rel = n.relation as Node | undefined;
        const key = tableKey((rel?.schemaname as string | undefined) ?? "public", rel?.relname as string);
        for (const cmdWrap of (n.cmds ?? []) as Node[]) {
          const cmd = cmdWrap.AlterTableCmd as Node | undefined;
          if (!cmd) continue;
          const colName = (cmd.def?.ColumnDef?.colname as string | undefined) ?? (cmd.name as string | undefined);
          for (const r of renames) {
            if (tableKey(r.schema, r.table) !== key) continue;
            if (cmd.subtype === "AT_AddColumn" && colName === r.from) {
              refusals.push(`${m.path}: ${key}.${r.from} is re-added after being renamed to ${r.to}; existing queries could mean either column`);
            }
            if (cmd.subtype === "AT_DropColumn" && colName === r.to) {
              refusals.push(`${m.path}: ${key}.${r.to} is dropped after the rename; nothing to rewrite to`);
            }
          }
        }
      }
    }
  }
  // Renames into a name that already existed would be rejected by PostgreSQL, so the
  // migration itself fails; that surfaces as a failed migration, not here.
  return { renames, refusals };
}
