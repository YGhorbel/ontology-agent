/**
 * Cumulative-measure detection (Fix 3) — deterministic, runs once in node 1b.
 *
 * Distinguishes a *per-event* measure (results.points — SUM is correct) from a
 * *cumulative snapshot* (driverstandings.points, constructorstandings.wins — a running
 * total carried race to race, so SUM double-counts; MAX / last-value-per-group is correct).
 *
 * Real schemas reset these totals per season, so a naïve "PARTITION BY entity ORDER BY
 * raceid" sees a drop at every season boundary and looks non-monotonic. We therefore join
 * the *sequence/calendar* table (the one the entity's events reference — e.g. `races`, which
 * carries a `year` season-group and a `round`/`date` within-season order) and probe:
 *
 *   value - LAG(value) OVER (PARTITION BY <entity cols>, <season group> ORDER BY <round/date>)
 *
 * A measure whose deltas are non-negative for `ONTOLOGY_MONOTONIC_MIN_RATIO` of rows is a
 * cumulative snapshot. The calendar table + its group/order columns are derived structurally
 * (a table with both a season-like and a round/date-like column, reached by a same-named key
 * column); when they cannot be derived we skip — determinism over recall, never a guess.
 */
import type { Queryable } from '../storage/pg.js';
import type { CanonicalSchema, Table } from '../types/canonical-schema.js';
import type { ColumnProfile } from '../types/column-profile.js';
import type { ForeignKeyCandidate } from '../types/foreign-key-candidate.js';
import { trustedUnaryFks } from './trusted-fk.js';

const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;

const NUMERIC_TYPES = new Set(['smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision']);
const isNumericType = (t: string): boolean => NUMERIC_TYPES.has(t.toLowerCase());
const isTemporalType = (t: string): boolean => /date|time/i.test(t);
const isSeasonName = (name: string): boolean => /season|year/i.test(name);
const isRoundName = (name: string): boolean => /round|sequence|order|^lap$/i.test(name);

const monotonicMinRatioFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_MONOTONIC_MIN_RATIO);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.99;
};

const stmtTimeoutMs = (): number => {
  const raw = Number(process.env.ONTOLOGY_VALIDATE_STMT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
};

export interface TemporalityEvidence {
  partitionColumns: string[];
  orderColumn: string;
  ratio: number;
}

/** A calendar table carries BOTH a season-like grouping and a round/date-like order. */
export function isCalendarTable(t: Table): boolean {
  const hasSeason = t.columns.some((c) => isSeasonName(c.name));
  const hasOrder = t.columns.some((c) => isRoundName(c.name) || isTemporalType(c.type));
  return hasSeason && hasOrder;
}

/**
 * Entity (partition) columns of a table: source columns of its TRUSTED unary FKs only
 * (declared / inferred-name / discovered ≥ EXPORT_MIN_CONF), excluding the sequence-join
 * column. Restricting to trusted FKs is what keeps a coincidental discovered FK on an
 * ordinal/measure column (e.g. `position ⊆ constructorid`) OUT of the partition — over-
 * partitioning by such a column fragments the per-entity series and would let a non-
 * cumulative measure look monotonic (Part 2a). A trusted FK target is the deterministic,
 * pre-capability proxy for an "entity/dimension" key here in node 1b.
 */
function entityFkColumns(table: string, schema: CanonicalSchema, fks: ForeignKeyCandidate[], exclude: string): string[] {
  const cols = new Set<string>();
  for (const fk of trustedUnaryFks(schema, fks)) if (fk.sourceTable === table) cols.add(fk.sourceColumn);
  cols.delete(exclude);
  return [...cols];
}

export interface SequencePlan {
  joinTable: string;
  joinFromColumn: string;
  joinToColumn: string;
  entityColumns: string[];
  groupColumn: string | null;
  orderColumn: string;
}

/** Pick the order column within a calendar table: a round/ordinal column, else a temporal one. */
function pickOrderColumn(cal: Table): string | null {
  return (
    cal.columns.find((c) => isRoundName(c.name))?.name ??
    cal.columns.find((c) => isTemporalType(c.type))?.name ??
    null
  );
}

/**
 * Derive the join + partition/order plan for a table, or null when it has no entity FK and a
 * reachable calendar table. The calendar table is found by a column shared by name (the
 * sequence key, e.g. `raceid`) — the same structural recovery used elsewhere in profiling.
 */
export function deriveSequencePlan(table: Table, schema: CanonicalSchema, fks: ForeignKeyCandidate[]): SequencePlan | null {
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  for (const c of table.columns) {
    for (const other of schema.tables) {
      if (other.name === table.name || !isCalendarTable(other)) continue;
      if (!other.columns.some((oc) => oc.name === c.name)) continue; // shared key column → sequence FK
      const cal = byName.get(other.name)!;
      const orderColumn = pickOrderColumn(cal);
      if (!orderColumn) continue;
      const entityColumns = entityFkColumns(table.name, schema, fks, c.name);
      if (entityColumns.length === 0) continue;
      const groupColumn = cal.columns.find((cc) => isSeasonName(cc.name))?.name ?? null;
      return { joinTable: other.name, joinFromColumn: c.name, joinToColumn: c.name, entityColumns, groupColumn, orderColumn };
    }
  }
  return null;
}

/** SQL probe: counts negative first-differences of `measure` within (entity, season) groups. */
export function buildMonotonicQuery(table: string, measure: string, plan: SequencePlan): string {
  const partition = [
    ...plan.entityColumns.map((c) => `t.${quoteIdent(c)}`),
    ...(plan.groupColumn ? [`r.${quoteIdent(plan.groupColumn)}`] : []),
  ].join(', ');
  const m = `t.${quoteIdent(measure)}`;
  return (
    `SELECT count(*) FILTER (WHERE d < 0) AS neg, count(d) AS tot FROM (` +
    `SELECT ${m} - lag(${m}) OVER (PARTITION BY ${partition} ORDER BY r.${quoteIdent(plan.orderColumn)}) AS d ` +
    `FROM ${quoteIdent(table)} t JOIN ${quoteIdent(plan.joinTable)} r ON t.${quoteIdent(plan.joinFromColumn)} = r.${quoteIdent(plan.joinToColumn)}) s`
  );
}

/**
 * Probe every qualifying table/measure. Returns a map "table col" -> evidence for columns
 * whose values are monotonic non-decreasing along the calendar sequence (cumulative).
 */
export async function detectCumulativeMeasures(
  q: Queryable,
  schema: CanonicalSchema,
  fks: ForeignKeyCandidate[],
  profiles: ColumnProfile[],
): Promise<Map<string, TemporalityEvidence>> {
  const out = new Map<string, TemporalityEvidence>();
  const minRatio = monotonicMinRatioFromEnv();
  const uniqByCol = new Map<string, number | null>();
  for (const p of profiles) uniqByCol.set(`${p.table} ${p.column}`, p.uniquenessRatio);

  await q.query(`SET LOCAL statement_timeout = ${stmtTimeoutMs()}`).catch(() => undefined);

  for (const table of schema.tables) {
    const plan = deriveSequencePlan(table, schema, fks);
    if (!plan) continue;

    const reserved = new Set<string>([plan.joinFromColumn, ...plan.entityColumns]);
    const measures = table.columns.filter((c) => {
      if (reserved.has(c.name)) return false;
      if (!isNumericType(c.type)) return false;
      const uniq = uniqByCol.get(`${table.name} ${c.name}`);
      return uniq === null || uniq === undefined || uniq < 1; // not a unique/key column
    });

    const partitionColumns = [...plan.entityColumns, ...(plan.groupColumn ? [plan.groupColumn] : [])];
    for (const measure of measures) {
      try {
        const { rows } = await q.query(buildMonotonicQuery(table.name, measure.name, plan));
        const neg = Number(rows[0]?.['neg'] ?? 0);
        const tot = Number(rows[0]?.['tot'] ?? 0);
        if (tot <= 0) continue; // no evidence — do not guess
        const ratio = (tot - neg) / tot;
        if (ratio >= minRatio) {
          out.set(`${table.name} ${measure.name}`, { partitionColumns, orderColumn: plan.orderColumn, ratio });
        }
      } catch {
        // A probe failure (timeout / type quirk) is non-fatal: skip this measure.
      }
    }
  }
  return out;
}
