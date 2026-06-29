/**
 * As-of-event snapshot detection (ADR-015) — deterministic, runs in node 1b right after the
 * monotonicity probe. Generalizes the cumulative-snapshot tag to the NON-monotonic species of
 * snapshot the monotonicity probe structurally misses: a state carried-forward as-of an event
 * whose value is not monotonic (a championship `position`/rank can drop 2nd→4th).
 *
 * A column `c` on table `T` is an **as-of-event snapshot** when BOTH hold — no column-name
 * special-casing, holds on any schema:
 *
 *  1. **Functional determination (structural grain coherence).** `T`'s grain is exactly
 *     `(entity, event)` — exactly one row per `(entity, event)` — so `c` is a STATE as-of the event,
 *     not one of many per-event measurements. This is the rigorous form of "the table is an
 *     entity-state table": it gates out per-lap / per-stop telemetry (`laptimes`, `pitstops`: many
 *     rows per `(driver, race)`) and tables with non-unique `(entity, event)` grain.
 *  2. **Carry-forward (data).** Along the event order, for a fixed entity, `c`'s values form a
 *     trajectory (autocorrelated) rather than independent per-event draws. Measured by the von
 *     Neumann-style ratio `var(Δ) / var(v)` within each `(entity, season)` partition: ≈2 for an
 *     i.i.d. per-event draw, →0 for a smoothly carried-forward state. Below
 *     `ONTOLOGY_SNAPSHOT_MAX_VN_RATIO` ⇒ carried-forward. A minimum fraction of non-zero steps
 *     (`ONTOLOGY_SNAPSHOT_MIN_MOVE_FRAC`) additionally excludes a near-CONSTANT attribute (e.g. a car
 *     number), whose ratio is also low but which is a static label, not a moving state.
 *
 * Symmetric discrimination is the whole point and is grounded in the live F1 data: standings
 * `position` (`var(Δ)/var(v)` ≈ 0.05) is tagged; the per-event siblings stay untagged because they
 * fail one gate or the other — `results.position` (≈0.80) and `qualifying.position` (≈0.51) fail
 * carry-forward, and `results.*` additionally fails functional determination (historic shared drives
 * make `(driver, race)` non-unique). Determinism over recall: with no rows / no variation / no
 * derivable plan, we skip rather than guess.
 *
 * NOTE (ADR-015): two signals planned from the diagnostic were FALSIFIED by the live data and replaced
 * here. "Table-coherence keyed off an already-cumulative sibling" inherited a constant-column
 * monotonicity false-positive (`qualifying.number` is constant per season ⇒ trivially non-decreasing
 * ⇒ tagged cumulative ⇒ would drag `qualifying.position` in). And a range-normalized mean step
 * (`avg|Δ|/range`) over-fired on every per-event F1 column. Functional-determination + the von Neumann
 * ratio are the robust replacements — a structural grain-coherence gate and a true carry-forward gate.
 */
import type { Queryable } from '../storage/pg.js';
import type { CanonicalSchema } from '../types/canonical-schema.js';
import type { ColumnProfile } from '../types/column-profile.js';
import type { ForeignKeyCandidate } from '../types/foreign-key-candidate.js';
import {
  type SequencePlan,
  type TemporalityEvidence,
  candidateMeasureColumns,
  deriveSequencePlan,
  planPartitionColumns,
  quoteIdent,
  uniquenessByColumn,
} from './monotonicity.js';

/** Max von Neumann ratio var(Δ)/var(v) for a column to count as carried-forward (lower ⇒ smoother). */
const snapshotMaxVnRatioFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_SNAPSHOT_MAX_VN_RATIO);
  return Number.isFinite(raw) && raw > 0 && raw < 2 ? raw : 0.1;
};

/** Min fraction of non-zero consecutive steps — excludes a near-constant attribute (e.g. a car number). */
const snapshotMinMoveFracFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_SNAPSHOT_MIN_MOVE_FRAC);
  return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.15;
};

const stmtTimeoutMs = (): number => {
  const raw = Number(process.env.ONTOLOGY_VALIDATE_STMT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
};

/**
 * SQL probe: does the table have exactly one row per `(entity…, event)`? Compares the row count to
 * the distinct count of the entity-partition columns plus the sequence-join (event) key.
 */
export function buildGrainUniquenessQuery(table: string, plan: SequencePlan): string {
  const keyCols = [...plan.entityColumns, plan.joinFromColumn].map((c) => `t.${quoteIdent(c)}`).join(', ');
  return `SELECT count(*) AS total, count(DISTINCT (${keyCols})) AS keys FROM ${quoteIdent(table)} t`;
}

/**
 * SQL probe: the von Neumann numerator/denominator for `measure` within `(entity, season)` groups
 * along the calendar order, plus the count of non-zero steps. `var(Δ)/var(v)` discriminates a
 * carried-forward trajectory (≈0) from an i.i.d. per-event draw (≈2); `moved/tot` excludes constants.
 */
export function buildVonNeumannQuery(table: string, measure: string, plan: SequencePlan): string {
  const partition = [
    ...plan.entityColumns.map((c) => `t.${quoteIdent(c)}`),
    ...(plan.groupColumn ? [`r.${quoteIdent(plan.groupColumn)}`] : []),
  ].join(', ');
  const m = `t.${quoteIdent(measure)}`;
  return (
    `SELECT var_samp(d) AS var_d, var_samp(v) AS var_v, count(d) AS tot, ` +
    `count(*) FILTER (WHERE d <> 0) AS moved FROM (` +
    `SELECT ${m}::double precision AS v, ${m} - lag(${m}) OVER (PARTITION BY ${partition} ORDER BY r.${quoteIdent(plan.orderColumn)}) AS d ` +
    `FROM ${quoteIdent(table)} t JOIN ${quoteIdent(plan.joinTable)} r ON t.${quoteIdent(plan.joinFromColumn)} = r.${quoteIdent(plan.joinToColumn)}) s`
  );
}

/**
 * Probe every qualifying table/measure for as-of-event snapshot grain. `cumulative` is the map from
 * `detectCumulativeMeasures`; columns already tagged cumulative keep that stronger tag and are skipped
 * here. Returns a map "table col" -> evidence for the carried-forward state columns.
 */
export async function detectSnapshotMeasures(
  q: Queryable,
  schema: CanonicalSchema,
  fks: ForeignKeyCandidate[],
  profiles: ColumnProfile[],
  cumulative: Map<string, TemporalityEvidence>,
): Promise<Map<string, TemporalityEvidence>> {
  const out = new Map<string, TemporalityEvidence>();
  const maxVn = snapshotMaxVnRatioFromEnv();
  const minMove = snapshotMinMoveFracFromEnv();
  const uniqByCol = uniquenessByColumn(profiles);

  await q.query(`SET LOCAL statement_timeout = ${stmtTimeoutMs()}`).catch(() => undefined);

  for (const table of schema.tables) {
    const plan = deriveSequencePlan(table, schema, fks);
    if (!plan) continue;

    const measures = candidateMeasureColumns(table, plan, uniqByCol).filter(
      (c) => !cumulative.has(`${table.name} ${c.name}`), // already the stronger cumulative tag
    );
    if (measures.length === 0) continue;

    // Gate 1 — functional determination: the table's grain must be exactly (entity, event).
    let grainUnique = false;
    try {
      const { rows } = await q.query(buildGrainUniquenessQuery(table.name, plan));
      const total = Number(rows[0]?.['total'] ?? 0);
      const keys = Number(rows[0]?.['keys'] ?? -1);
      grainUnique = total > 0 && total === keys;
    } catch {
      grainUnique = false;
    }
    if (!grainUnique) continue; // multi-row-per-event (telemetry) or non-unique grain — not a state table

    const partitionColumns = planPartitionColumns(plan);
    // Gate 2 — carry-forward: von Neumann ratio low AND the column actually moves.
    for (const measure of measures) {
      try {
        const { rows } = await q.query(buildVonNeumannQuery(table.name, measure.name, plan));
        const varD = Number(rows[0]?.['var_d'] ?? NaN);
        const varV = Number(rows[0]?.['var_v'] ?? NaN);
        const tot = Number(rows[0]?.['tot'] ?? 0);
        const moved = Number(rows[0]?.['moved'] ?? 0);
        if (tot <= 0 || !(varV > 0) || !Number.isFinite(varD)) continue; // no evidence / constant — skip
        if (moved / tot < minMove) continue; // near-constant attribute, not a moving state
        const vnRatio = varD / varV;
        if (vnRatio <= maxVn) {
          out.set(`${table.name} ${measure.name}`, {
            partitionColumns,
            orderColumn: plan.orderColumn,
            signal: 'carry-forward',
            vnRatio,
          });
        }
      } catch {
        // A probe failure (timeout / type quirk) is non-fatal: skip this measure.
      }
    }
  }
  return out;
}
