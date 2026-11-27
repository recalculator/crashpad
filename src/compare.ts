import type { Column, QueryResult, Row } from "./db/postgres.ts";

export interface ColumnDiff {
  baseline: Column[];
  candidate: Column[];
  changes: string[];
}

export interface RowDiff {
  /** Rows (by multiplicity) present in baseline but not candidate. */
  missingCount: number;
  /** Rows (by multiplicity) present in candidate but not baseline. */
  extraCount: number;
  /** For ordered comparison: first differing row index. */
  firstDifferenceAt?: number;
  baselineRowCount: number;
  candidateRowCount: number;
  samples: { missing: Row[]; extra: Row[] };
}

export function compareColumns(a: Column[], b: Column[]): ColumnDiff | null {
  const changes: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const x = a[i];
    const y = b[i];
    if (x && !y) changes.push(`column ${i + 1} "${x.name}" (${x.type}) was removed`);
    else if (!x && y) changes.push(`column ${i + 1} "${y.name}" (${y.type}) was added`);
    else if (x && y) {
      if (x.name !== y.name) changes.push(`column ${i + 1} renamed "${x.name}" → "${y.name}"`);
      if (x.type !== y.type) changes.push(`column ${i + 1} "${y.name}" type changed ${x.type} → ${y.type}`);
    }
  }
  return changes.length ? { baseline: a, candidate: b, changes } : null;
}

/** Project rows onto the columns that are not ignored (by name). */
export function dropIgnored(result: QueryResult, ignore: string[]): { columns: Column[]; rows: Row[] } {
  if (ignore.length === 0) return { columns: result.columns, rows: result.rows };
  const keep = result.columns.map((c, i) => (ignore.includes(c.name) ? -1 : i)).filter((i) => i >= 0);
  return { columns: keep.map((i) => result.columns[i]!), rows: result.rows.map((r) => keep.map((i) => r[i] ?? null)) };
}

const rowKey = (r: Row): string => JSON.stringify(r);

/**
 * Compare result rows. Unordered comparison treats rows as a multiset: the same
 * rows with different duplicate counts are a difference. Values are compared as
 * PostgreSQL's exact text representation.
 */
export function compareRows(a: Row[], b: Row[], ordered: boolean, sampleLimit: number): RowDiff | null {
  if (ordered) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i];
      const y = b[i];
      if (!x || !y || rowKey(x) !== rowKey(y)) {
        const unordered = compareRows(a, b, false, sampleLimit);
        return {
          missingCount: unordered?.missingCount ?? 0,
          extraCount: unordered?.extraCount ?? 0,
          firstDifferenceAt: i,
          baselineRowCount: a.length,
          candidateRowCount: b.length,
          samples: {
            missing: x ? [x].slice(0, sampleLimit) : [],
            extra: y ? [y].slice(0, sampleLimit) : [],
          },
        };
      }
    }
    return null;
  }
  const counts = new Map<string, { row: Row; n: number }>();
  for (const r of a) {
    const k = rowKey(r);
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { row: r, n: 1 });
  }
  const extra: Row[] = [];
  let extraCount = 0;
  for (const r of b) {
    const e = counts.get(rowKey(r));
    if (e && e.n > 0) e.n--;
    else {
      extraCount++;
      if (extra.length < sampleLimit) extra.push(r);
    }
  }
  const missing: Row[] = [];
  let missingCount = 0;
  for (const { row, n } of counts.values()) {
    missingCount += n;
    for (let i = 0; i < n && missing.length < sampleLimit; i++) missing.push(row);
  }
  if (missingCount === 0 && extraCount === 0) return null;
  return { missingCount, extraCount, baselineRowCount: a.length, candidateRowCount: b.length, samples: { missing, extra } };
}
