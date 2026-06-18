/**
 * Bounded composite (2-column) foreign-key discovery (Fix 7) — deterministic, runs once in 1b.
 *
 * Some joins need two keys at once: laptimes(raceid, driverid) → results(raceid, driverid).
 * The ontology has each *unary* FK (raceid→races, driverid→drivers) but no direct path between
 * the two fact tables, so a "lap time per constructor" query has to detour through a shared
 * dimension and silently fan out. This recovers the direct composite edge.
 *
 * The hard part is precision: small overlapping integers (position, stop, round, lap) satisfy
 * approximate inclusion dependencies, so a containment scan alone manufactures dozens of
 * garbage edges (pitstops.stop ⊆ constructorstandings.position, etc.). We therefore form a
 * candidate composite A.[x,y] → B.[u,v] ONLY when ALL of these hold, checked BEFORE any scan:
 *
 *   1. Distinct columns on both sides: x ≠ y and u ≠ v (no column doubled as a "pair").
 *   2. Per-column trusted-unary prerequisite: x↔u and y↔v are each a *co-reference* — both
 *      sides hold a TRUSTED unary FK (declared / inferred-name / discovered ≥ EXPORT_MIN_CONF)
 *      into the SAME parent column. The two correspondences must hit two DISTINCT parents.
 *      (laptimes.raceid & results.raceid both → races.raceid; both .driverid → drivers.driverid.)
 *   3. Real composite key on the target: (u,v) is a discovered/declared 2-distinct-column unique
 *      key on B (from Step-2 key discovery) — not a single unique column doubled, not just a PK.
 *   4. Non-redundancy: neither u nor v is individually unique on B (else a unary FK already
 *      determines the parent row and the composite adds nothing).
 *   5. Caps: 2-column pairs only; skip tables over ONTOLOGY_COMPOSITE_MAX_ROWS; verify the
 *      2-column IND with one containment scan gated by ONTOLOGY_IND_MIN_CONTAINMENT.
 *
 * Rules 1–4 are pure functions of profiling state (FK graph + key candidates); only survivors
 * pay a single containment scan. The direction (which side is parent) is decided by rules 3+4,
 * not a uniqueness heuristic.
 */
import type { Queryable } from '../storage/pg.js';
import type { CanonicalSchema } from '../types/canonical-schema.js';
import type { ColumnProfile } from '../types/column-profile.js';
import type { ForeignKeyCandidate, CompositeForeignKeyCandidate } from '../types/foreign-key-candidate.js';
import type { KeyCandidate } from '../types/key-candidate.js';
import { trustedUnaryFks, trustedFkMinConfFromEnv } from './trusted-fk.js';

const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;

const indMinContainment = (): number => {
  const raw = Number(process.env.ONTOLOGY_IND_MIN_CONTAINMENT);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7;
};
const compositeMaxRowsFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_COMPOSITE_MAX_ROWS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5_000_000;
};
const stmtTimeoutMs = (): number => {
  const raw = Number(process.env.ONTOLOGY_VALIDATE_STMT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
};

/** Order-independent key for a 2-column set. */
const pairKey = (a: string, b: string): string => [a, b].slice().sort().join(',');

export function buildCompositeContainmentQuery(
  child: string,
  childCols: [string, string],
  parent: string,
  parentCols: [string, string],
): string {
  const [a1, a2] = childCols.map(quoteIdent);
  const [b1, b2] = parentCols.map(quoteIdent);
  return (
    `SELECT count(*) AS src_distinct, count(*) FILTER (WHERE t.k1 IS NULL) AS missing FROM (` +
    `SELECT DISTINCT ${a1} AS k1, ${a2} AS k2 FROM ${quoteIdent(child)} WHERE ${a1} IS NOT NULL AND ${a2} IS NOT NULL) s ` +
    `LEFT JOIN (SELECT DISTINCT ${b1} AS k1, ${b2} AS k2 FROM ${quoteIdent(parent)}) t ON t.k1 = s.k1 AND t.k2 = s.k2`
  );
}

/** A trusted unary FK column of a table → which parent column it references. */
interface ParentRef {
  col: string;
  parent: string;
  parentCol: string;
}

/** Two-column unique keys (R3) and single-column uniques (R4) per table, plus key-ness ratios. */
interface KeyIndex {
  composite2: Map<string, Set<string>>; // table -> set of sorted "u,v" 2-col unique keys
  single: Map<string, Set<string>>; // table -> set of single-column unique columns
  uniqueness: Map<string, number>; // "table|u,v" -> distinct/total ratio of the pair (≈1 for a key)
}

function indexKeys(keys: KeyCandidate[]): KeyIndex {
  const composite2 = new Map<string, Set<string>>();
  const single = new Map<string, Set<string>>();
  const uniqueness = new Map<string, number>();
  for (const k of keys) {
    if (!k.unique) continue;
    if (k.columns.length === 1) {
      const set = single.get(k.table) ?? new Set<string>();
      set.add(k.columns[0] as string);
      single.set(k.table, set);
    } else if (k.columns.length === 2 && k.columns[0] !== k.columns[1]) {
      const pk = pairKey(k.columns[0] as string, k.columns[1] as string);
      const set = composite2.get(k.table) ?? new Set<string>();
      set.add(pk);
      composite2.set(k.table, set);
      const ratio = k.distinctCount !== null && k.numRows > 0 ? k.distinctCount / k.numRows : 1;
      uniqueness.set(`${k.table}|${pk}`, ratio);
    }
  }
  return { composite2, single, uniqueness };
}

/** Co-reference correspondences between A and B: (aCol, bCol) reaching the same parent column. */
function correspondences(refsA: ParentRef[], refsB: ParentRef[]): Array<{ aCol: string; bCol: string; parent: string }> {
  const out: Array<{ aCol: string; bCol: string; parent: string }> = [];
  for (const a of refsA) {
    for (const b of refsB) {
      if (a.parent === b.parent && a.parentCol === b.parentCol) out.push({ aCol: a.col, bCol: b.col, parent: a.parent });
    }
  }
  return out;
}

export async function discoverCompositeForeignKeys(
  q: Queryable,
  schema: CanonicalSchema,
  fks: ForeignKeyCandidate[],
  keys: KeyCandidate[],
  profiles: ColumnProfile[],
): Promise<CompositeForeignKeyCandidate[]> {
  const minConf = trustedFkMinConfFromEnv();
  // R2 input: trusted unary FK columns per source table → their parent column.
  const refsByTable = new Map<string, ParentRef[]>();
  for (const fk of trustedUnaryFks(schema, fks, minConf)) {
    const list = refsByTable.get(fk.sourceTable) ?? [];
    list.push({ col: fk.sourceColumn, parent: fk.targetTable, parentCol: fk.targetColumn });
    refsByTable.set(fk.sourceTable, list);
  }
  const { composite2, single, uniqueness } = indexKeys(keys);

  const rowsByTable = new Map<string, number>();
  for (const p of profiles) rowsByTable.set(p.table, Math.max(rowsByTable.get(p.table) ?? 0, p.numRows));

  const maxRows = compositeMaxRowsFromEnv();
  const minContainment = indMinContainment();
  const best = new Map<string, CompositeForeignKeyCandidate>();

  await q.query(`SET LOCAL statement_timeout = ${stmtTimeoutMs()}`).catch(() => undefined);

  const tables = [...refsByTable.keys()].sort();
  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const A = tables[i] as string;
      const B = tables[j] as string;
      if ((rowsByTable.get(A) ?? 0) > maxRows || (rowsByTable.get(B) ?? 0) > maxRows) continue;
      const corr = correspondences(refsByTable.get(A) as ParentRef[], refsByTable.get(B) as ParentRef[]);
      if (corr.length < 2) continue;

      for (let m = 0; m < corr.length; m += 1) {
        for (let n = m + 1; n < corr.length; n += 1) {
          const c1 = corr[m]!;
          const c2 = corr[n]!;
          if (c1.parent === c2.parent) continue; // R2: two DISTINCT shared parents
          if (c1.aCol === c2.aCol || c1.bCol === c2.bCol) continue; // R1: distinct columns each side
          const aCols: [string, string] = [c1.aCol, c2.aCol];
          const bCols: [string, string] = [c1.bCol, c2.bCol];

          // Direction is decided by R3/R4: the parent side is whichever holds (cols) as a real
          // 2-column unique key that no single component already keys. Evaluate both orientations.
          const orientations: Array<{ child: string; childCols: [string, string]; parent: string; parentCols: [string, string] }> = [
            { child: A, childCols: aCols, parent: B, parentCols: bCols },
            { child: B, childCols: bCols, parent: A, parentCols: aCols },
          ];
          for (const o of orientations) {
            const pk = pairKey(o.parentCols[0], o.parentCols[1]);
            if (!composite2.get(o.parent)?.has(pk)) continue; // R3: genuine composite key on the parent
            const su = single.get(o.parent);
            if (su && (su.has(o.parentCols[0]) || su.has(o.parentCols[1]))) continue; // R4: not unary-redundant

            try {
              const { rows } = await q.query(buildCompositeContainmentQuery(o.child, o.childCols, o.parent, o.parentCols));
              const srcDistinct = Number(rows[0]?.['src_distinct'] ?? 0);
              const missing = Number(rows[0]?.['missing'] ?? 0);
              if (srcDistinct <= 0) continue;
              const containment = (srcDistinct - missing) / srcDistinct;
              if (containment < minContainment) continue; // R5: 2-column IND gate

              const parentU = uniqueness.get(`${o.parent}|${pk}`) ?? 1;
              const score = Math.min(containment, parentU);
              const dirKey = `${o.child}|${o.parent}`;
              const prev = best.get(dirKey);
              if (!prev || score > prev.score) {
                best.set(dirKey, {
                  sourceTable: o.child,
                  sourceColumns: o.childCols,
                  targetTable: o.parent,
                  targetColumns: o.parentCols,
                  containmentRatio: containment,
                  targetUniqueness: parentU,
                  score,
                });
              }
            } catch {
              // A probe failure (timeout / type mismatch) is non-fatal: skip this orientation.
            }
          }
        }
      }
    }
  }
  return [...best.values()];
}
