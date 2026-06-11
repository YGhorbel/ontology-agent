/**
 * Column-fact derivation (deterministic) + a small value-dictionary scan.
 *
 * Turns the Step-1 `ColumnProfile[]` and Step-2 `KeyCandidate[]` already computed by
 * the profiling pipeline into per-column `ColumnFact`s the SQL generator needs:
 * data type, numeric-as-text detection, key/uniqueness flags, and — for
 * low-cardinality columns — a sampled value dictionary so filter literals can be
 * mapped (`status = 'Finished'`). Everything is derived from data, never from column
 * names, so it works on any schema.
 */
import type { Queryable } from '../storage/pg.js';
import type { ColumnProfile } from '../types/column-profile.js';
import type { KeyCandidate } from '../types/key-candidate.js';
import { ColumnFactSchema, type ColumnFact } from '../types/column-fact.js';
import { typeFamily } from './candidate-pairs.js';

const key2 = (t: string, c: string): string => `${t} ${c}`;
const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;

const isFiniteNumeric = (s: string): boolean => s.trim() !== '' && Number.isFinite(Number(s));

/**
 * Max distinct values for a column to be treated as a small enumeration — gets a
 * sampled value dictionary and full `qsl:sampleValues` emission. `ONTOLOGY_ENUM_MAX_DISTINCT`
 * (default 50) is the primary knob; the legacy `ONTOLOGY_VALUE_DICT_MAX_DISTINCT` still
 * wins when set (back-compat).
 */
export const enumMaxDistinctFromEnv = (): number => {
  const legacy = Number(process.env.ONTOLOGY_VALUE_DICT_MAX_DISTINCT);
  if (Number.isFinite(legacy) && legacy > 0) return Math.floor(legacy);
  const raw = Number(process.env.ONTOLOGY_ENUM_MAX_DISTINCT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
};

/** Common sentinels that stand in for unknown/missing in low-cardinality columns. */
const NULL_SENTINELS = new Set(['', '-', '--', 'n/a', 'na', 'null', 'none', 'unknown', '?', '\\n']);

/** First sentinel found among sampled values, or null — surfaced as `qsl:nullPlaceholder`. */
export function detectNullPlaceholder(sampleValues: string[]): string | null {
  for (const v of sampleValues) {
    if (NULL_SENTINELS.has(v.trim().toLowerCase())) return v;
  }
  return null;
}

/**
 * A *text*-typed column whose min and max both parse as finite numbers — i.e. the
 * values are numbers stored as text, so `ORDER BY`/`MIN`/`SUM` need a cast (lexical
 * order is wrong: `'10' < '2'`). Purely data-derived.
 */
export function isNumericText(profile: ColumnProfile): boolean {
  if (typeFamily(profile.dataType) !== 'text') return false;
  if (profile.min === null || profile.max === null) return false;
  return isFiniteNumeric(profile.min) && isFiniteNumeric(profile.max);
}

/** "table col" keys of single-column unique keys — the columns to skip for value dictionaries. */
export function uniqueKeyColumns(keys: KeyCandidate[]): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    if (k.columns.length === 1 && k.unique) out.add(key2(k.table, k.columns[0] as string));
  }
  return out;
}

export interface ValueDictOptions {
  maxDistinct?: number;
}

/**
 * Sample up to `maxDistinct` distinct values for each low-cardinality, non-key column
 * (one bounded `SELECT DISTINCT … LIMIT N` per column). Skips unmeasured / high-card /
 * key columns. Values are returned as text.
 */
export async function sampleCategoricalValues(
  q: Queryable,
  profiles: ColumnProfile[],
  keyCols: Set<string>,
  opts: ValueDictOptions = {},
): Promise<Map<string, string[]>> {
  const max = opts.maxDistinct ?? enumMaxDistinctFromEnv();
  const out = new Map<string, string[]>();
  for (const p of profiles) {
    if (p.distinctCount === null || p.distinctCount <= 0 || p.distinctCount > max) continue;
    if (keyCols.has(key2(p.table, p.column))) continue; // ID-like; a dictionary is pointless
    const col = quoteIdent(p.column);
    const sql =
      `SELECT DISTINCT ${col}::text AS v FROM ${quoteIdent(p.table)} ` +
      `WHERE ${col} IS NOT NULL ORDER BY 1 LIMIT ${max}`;
    const { rows } = await q.query(sql);
    const values = rows.map((r) => r['v']).filter((v): v is string => typeof v === 'string');
    if (values.length > 0) out.set(key2(p.table, p.column), values);
  }
  return out;
}

/** Pure join of profiles + keys + sampled values into one `ColumnFact` per column. */
export function deriveColumnFacts(
  profiles: ColumnProfile[],
  keys: KeyCandidate[],
  samplesByCol: Map<string, string[]>,
): ColumnFact[] {
  const unique = uniqueKeyColumns(keys);
  const primary = new Set<string>();
  for (const k of keys) {
    if (k.columns.length === 1 && k.declared === 'primary') primary.add(key2(k.table, k.columns[0] as string));
  }

  return profiles.map((p) => {
    const id = key2(p.table, p.column);
    const sampleValues = samplesByCol.get(id) ?? [];
    const placeholder = detectNullPlaceholder(sampleValues);
    return ColumnFactSchema.parse({
      table: p.table,
      column: p.column,
      dataType: p.dataType,
      isNumericText: isNumericText(p),
      isUnique: unique.has(id),
      isPrimaryKey: primary.has(id),
      distinctCount: p.distinctCount,
      nullable: p.nullCount > 0, // data-observed: the column contains NULLs
      sampleValues,
      numRows: p.numRows,
      nullCount: p.nullCount,
      min: p.min,
      max: p.max,
      ...(placeholder !== null ? { nullPlaceholder: placeholder } : {}),
    });
  });
}

/** Sample value dictionaries (one DB pass) then derive the full `ColumnFact[]`. */
export async function buildColumnFacts(
  q: Queryable,
  profiles: ColumnProfile[],
  keys: KeyCandidate[],
  opts: ValueDictOptions = {},
): Promise<ColumnFact[]> {
  const keyCols = uniqueKeyColumns(keys);
  const samples = await sampleCategoricalValues(q, profiles, keyCols, opts);
  return deriveColumnFacts(profiles, keys, samples);
}
