/**
 * Uniqueness / key discovery (deterministic, no LLM).
 *
 * Identifies the unique column-sets of each table — the legal *target sides*
 * (RHS) for relationship discovery, since a foreign key can only point at a
 * unique column-set. See Abedjan, Golab & Naumann, "Profiling relational data:
 * a survey" (VLDB Journal 2015), §5.1:
 *
 *   - X is unique  iff  COUNT(DISTINCT X) == COUNT(*).
 *   - a *certain* key has no NULLs (a valid FK target); a *possible* key is
 *     unique but nullable.
 *   - full minimal-unique discovery is NP-hard, so we stay bounded:
 *       1. single-column uniques  — free, derived from the Step-1 profiles;
 *       2. 2-column uniques        — Apriori-pruned, hard-capped SQL probes;
 *       3. declared PK / UNIQUE    — read from the catalog and cross-tagged.
 *
 * Pure functions over the injected `Queryable` port. Standalone (not wired into
 * the agent graph); the relationship-discovery axes consume it.
 */
import type { Queryable } from '../storage/pg.js';
import type { CanonicalSchema, Column } from '../types/canonical-schema.js';
import type { ColumnProfile } from '../types/column-profile.js';
import { KeyCandidateSchema, type KeyCandidate } from '../types/key-candidate.js';
import { PROFILABLE_TYPES } from './single-column.js';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;

/** Order-independent key for matching a column-set against declared constraints. */
const setKey = (columns: string[]): string => [...columns].sort().join(' ');

export interface KeyDiscoveryOptions {
  /** Largest column-set size to probe. Only k≤2 is implemented; default 2. */
  maxK?: number;
  /** Hard cap on the number of 2-column pairs tested per table. Default 200. */
  maxPairs?: number;
}

const DEFAULT_MAX_PAIRS = 200;

/**
 * Single-column keys, derived from existing single-column profiles — no SQL.
 * A column with uniquenessRatio === 1.0 (over a non-empty table) is a unique.
 */
export function singleColumnKeys(profiles: ColumnProfile[]): KeyCandidate[] {
  const keys: KeyCandidate[] = [];
  for (const p of profiles) {
    if (p.numRows > 0 && p.uniquenessRatio === 1) {
      keys.push(
        KeyCandidateSchema.parse({
          table: p.table,
          columns: [p.column],
          numRows: p.numRows,
          distinctCount: p.distinctCount,
          unique: true,
          certain: p.nullCount === 0,
          minimal: true,
          declared: null,
          method: 'single-column',
        }),
      );
    }
  }
  return keys;
}

interface DeclaredKey {
  columns: string[];
  kind: 'primary' | 'unique';
}

/**
 * Declared PRIMARY KEY / UNIQUE constraints from the catalog, grouped by table.
 * Mirrors the FK-reading join in node 1 (schema-ingest).
 */
export async function readDeclaredKeys(q: Queryable): Promise<Map<string, DeclaredKey[]>> {
  const { rows } = await q.query(
    `SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
            kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`,
  );

  // Group columns per constraint (rows arrive ordered by ordinal_position).
  const byConstraint = new Map<string, { table: string; kind: 'primary' | 'unique'; columns: string[] }>();
  for (const r of rows) {
    const table = String(r['table_name']);
    const cname = String(r['constraint_name']);
    const kind = String(r['constraint_type']) === 'PRIMARY KEY' ? 'primary' : 'unique';
    const key = `${table} ${cname}`;
    const entry = byConstraint.get(key) ?? { table, kind, columns: [] };
    entry.columns.push(String(r['column_name']));
    byConstraint.set(key, entry);
  }

  const byTable = new Map<string, DeclaredKey[]>();
  for (const e of byConstraint.values()) {
    const list = byTable.get(e.table) ?? [];
    list.push({ columns: e.columns, kind: e.kind });
    byTable.set(e.table, list);
  }
  return byTable;
}

/** One batched SELECT testing the uniqueness of several 2-column pairs. Exported for testing. */
export function buildCompositeKeyQuery(table: string, pairs: Array<[string, string]>): string {
  const selects = ['count(*) AS n'];
  pairs.forEach(([a, b], i) => {
    selects.push(`count(DISTINCT (${quoteIdent(a)}, ${quoteIdent(b)})) AS k${i}`);
  });
  return `SELECT ${selects.join(', ')} FROM ${quoteIdent(table)}`;
}

/**
 * Bounded composite (k=2) key discovery with Apriori pruning.
 *
 * Candidate columns exclude single-column uniques (every superset of a unique is
 * unique, hence non-minimal) and are restricted to non-null, profilable columns
 * (keeps COUNT(DISTINCT row) NULL-semantics clean; FK targets are certain keys).
 * Pairs are hard-capped at `maxPairs` with a warning — never silently truncated.
 */
export async function discoverCompositeKeys(
  q: Queryable,
  table: string,
  columns: Column[],
  profiles: ColumnProfile[],
  opts: KeyDiscoveryOptions = {},
): Promise<KeyCandidate[]> {
  const maxK = opts.maxK ?? 2;
  if (maxK < 2) return []; // k=2 is the only implemented level (k≥3 is out of scope by design)
  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS;

  const profByName = new Map(profiles.map((p) => [p.column, p]));
  const candidates = columns
    .filter((c) => {
      const p = profByName.get(c.name);
      if (!p || p.numRows === 0) return false;
      if (p.uniquenessRatio === 1) return false; // already unique → superset-of-unique pruning
      if (p.nullCount !== 0) return false; // certain-key focus + clean NULL semantics
      return PROFILABLE_TYPES.has(c.type);
    })
    .map((c) => c.name);

  let pairs: Array<[string, string]> = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      pairs.push([candidates[i] as string, candidates[j] as string]);
    }
  }
  if (pairs.length === 0) return [];
  if (pairs.length > maxPairs) {
    console.warn(
      `[key-discovery] ${table}: ${pairs.length} candidate column-pairs exceed cap ${maxPairs}; testing first ${maxPairs}.`,
    );
    pairs = pairs.slice(0, maxPairs);
  }

  const { rows } = await q.query(buildCompositeKeyQuery(table, pairs));
  const row = rows[0] ?? {};
  const numRows = num(row['n']) ?? 0;

  const keys: KeyCandidate[] = [];
  pairs.forEach(([a, b], i) => {
    const distinct = num(row[`k${i}`]);
    if (distinct !== null && numRows > 0 && distinct === numRows) {
      keys.push(
        KeyCandidateSchema.parse({
          table,
          columns: [a, b],
          numRows,
          distinctCount: distinct,
          unique: true,
          certain: true, // candidates were restricted to non-null columns
          minimal: true, // subsets are non-unique by construction
          declared: null,
          method: 'composite-probe',
        }),
      );
    }
  });
  return keys;
}

/**
 * Discover all key candidates for a schema: single-column + bounded composite
 * uniques, each cross-tagged against declared PRIMARY KEY / UNIQUE constraints.
 * Declared keys not recovered from the data are appended as method 'declared'.
 */
export async function discoverKeys(
  q: Queryable,
  schema: CanonicalSchema,
  profiles: ColumnProfile[],
  opts: KeyDiscoveryOptions = {},
): Promise<KeyCandidate[]> {
  const declaredByTable = await readDeclaredKeys(q);
  const result: KeyCandidate[] = [];

  for (const table of schema.tables) {
    const tableProfiles = profiles.filter((p) => p.table === table.name);
    const discovered = [
      ...singleColumnKeys(tableProfiles),
      ...(await discoverCompositeKeys(q, table.name, table.columns, tableProfiles, opts)),
    ];

    const declared = declaredByTable.get(table.name) ?? [];
    const declaredBySet = new Map<string, 'primary' | 'unique'>();
    for (const d of declared) declaredBySet.set(setKey(d.columns), d.kind);

    // Tag discovered keys that match a declared constraint.
    for (const c of discovered) {
      const kind = declaredBySet.get(setKey(c.columns));
      if (kind) c.declared = kind;
    }

    // Append declared keys the data step did not recover (e.g. composite PK with >2 cols).
    const discoveredSets = new Set(discovered.map((c) => setKey(c.columns)));
    const numRows = tableProfiles[0]?.numRows ?? 0;
    for (const d of declared) {
      if (discoveredSets.has(setKey(d.columns))) continue;
      result.push(
        KeyCandidateSchema.parse({
          table: table.name,
          columns: d.columns,
          numRows,
          distinctCount: null, // not measured against the data
          unique: true, // trusted from the constraint
          certain: d.kind === 'primary', // PK columns are NOT NULL
          minimal: true,
          declared: d.kind,
          method: 'declared',
        }),
      );
    }

    result.push(...discovered);
  }
  return result;
}
