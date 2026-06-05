/**
 * Single-column profiler (deterministic, no LLM).
 *
 * Computes the cheap per-column statistics that feed foreign-key /
 * inclusion-dependency discovery — see Abedjan, Golab & Naumann, "Profiling
 * relational data: a survey" (VLDB Journal 2015), §3.1/§3.3:
 *
 *   dataType, numRows, nullCount, distinctCount, uniquenessRatio, min, max
 *
 * Efficiency (§3.1): every metric except `distinctCount` is single-pass, so all
 * aggregates for a table are batched into ONE `SELECT` (mirrors the
 * `readNumericStats` idiom in node 1). Pure functions over the injected
 * `Queryable` port — tests feed a fake, no real database required.
 *
 * Standalone utility: not wired into the agent graph; the relationship-discovery
 * axes (Sprint 1–2) consume it.
 */
import type { Queryable } from '../storage/pg.js';
import type { CanonicalSchema, Column } from '../types/canonical-schema.js';
import { ColumnProfileSchema, type ColumnProfile } from '../types/column-profile.js';

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/**
 * `information_schema.columns.data_type` values that safely support
 * `COUNT(DISTINCT ...)`, `MIN(...)` and `MAX(...)`. Columns whose type is NOT in
 * this set still get `numRows`/`nullCount` (which work for any type), but their
 * `distinctCount`/`min`/`max` are left null — this avoids runtime errors on
 * types that lack equality/ordering (json, xml, ARRAY, geometric types, …).
 */
export const PROFILABLE_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'decimal',
  'real',
  'double precision',
  'money',
  'text',
  'character varying',
  'character',
  'uuid',
  'boolean',
  'date',
  'timestamp without time zone',
  'timestamp with time zone',
  'time without time zone',
  'time with time zone',
]);

const isProfilable = (type: string): boolean => PROFILABLE_TYPES.has(type);

/** Stable per-column alias prefix, keyed by index to dodge the 63-char identifier limit. */
const alias = (i: number, suffix: string): string => `c${i}__${suffix}`;

/**
 * Build the single batched profiling query for one table. Exported for testing.
 * Always selects `count(*)` and a non-null count per column; adds
 * distinct/min/max only for profilable types.
 */
export function buildProfileQuery(table: string, columns: Column[]): string {
  const selects = ['count(*) AS n'];
  columns.forEach((c, i) => {
    const col = quoteIdent(c.name);
    selects.push(`count(${col}) AS ${alias(i, 'nn')}`);
    if (isProfilable(c.type)) {
      selects.push(`count(DISTINCT ${col}) AS ${alias(i, 'd')}`);
      selects.push(`min(${col})::text AS ${alias(i, 'min')}`);
      selects.push(`max(${col})::text AS ${alias(i, 'max')}`);
    }
  });
  return `SELECT ${selects.join(', ')} FROM ${quoteIdent(table)}`;
}

/** Profile every column of one table with a single round-trip. */
export async function profileTable(
  q: Queryable,
  table: string,
  columns: Column[],
): Promise<ColumnProfile[]> {
  if (columns.length === 0) return [];
  const { rows } = await q.query(buildProfileQuery(table, columns));
  const row = rows[0] ?? {};
  const numRows = num(row['n']) ?? 0;

  return columns.map((c, i) => {
    const nonNull = num(row[alias(i, 'nn')]) ?? 0;
    const nullCount = Math.max(0, numRows - nonNull);
    const profilable = isProfilable(c.type);
    const distinctCount = profilable ? num(row[alias(i, 'd')]) : null;
    const uniquenessRatio =
      distinctCount !== null && numRows > 0 ? distinctCount / numRows : null;

    return ColumnProfileSchema.parse({
      table,
      column: c.name,
      dataType: c.type,
      numRows,
      nullCount,
      nullRatio: numRows > 0 ? nullCount / numRows : 0,
      distinctCount,
      uniquenessRatio,
      min: profilable ? str(row[alias(i, 'min')]) : null,
      max: profilable ? str(row[alias(i, 'max')]) : null,
    });
  });
}

/** Profile every column of every table in a canonical schema (one query per table). */
export async function profileSchema(
  q: Queryable,
  schema: CanonicalSchema,
): Promise<ColumnProfile[]> {
  const profiles: ColumnProfile[] = [];
  for (const t of schema.tables) {
    profiles.push(...(await profileTable(q, t.name, t.columns)));
  }
  return profiles;
}
