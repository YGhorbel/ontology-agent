/**
 * Column fact: query-ready metadata for one column, distilled from profiling so
 * the SQL generator can cast correctly, map filter literals, and reason about grain.
 *
 * This closes the gap where the ontology's `owl:DatatypeProperty` knew a column's
 * name but not its *type*, *keyness*, or *values* — the source of silently-wrong SQL
 * (a number stored as text sorts lexicographically, a filter literal never matches,
 * an aggregate double-counts). Every field is derived from data, never from column
 * names, so it holds on any schema. zod is the source of truth.
 */
import { z } from 'zod';

export const ColumnFactSchema = z.object({
  table: z.string(),
  column: z.string(),
  /** Canonical engine type, e.g. "integer", "text", "timestamp with time zone". */
  dataType: z.string(),
  /** A text-typed column whose values all parse as numbers → cast before sort/aggregate. */
  isNumericText: z.boolean(),
  /** The column is a single-column unique key (observed in the data). */
  isUnique: z.boolean(),
  /** The uniqueness is constraint-backed (declared PRIMARY KEY or UNIQUE), not just observed. */
  declaredUnique: z.boolean().optional(),
  /** The column is a declared single-column primary key. */
  isPrimaryKey: z.boolean(),
  /** Distinct value count, or null when not measured (non-profilable type). */
  distinctCount: z.number().int().nonnegative().nullable(),
  nullable: z.boolean(),
  /** A small value dictionary for low-cardinality columns; empty for high-cardinality / ID columns. */
  sampleValues: z.array(z.string()).default([]),

  // --- Profiling statistics (optional; populated from the Step-1 ColumnProfile) ---
  /** Total rows in the table at profiling time. */
  numRows: z.number().int().nonnegative().optional(),
  /** Number of NULLs observed in this column. */
  nullCount: z.number().int().nonnegative().optional(),
  /** Min value as text (null when not measured). */
  min: z.string().nullable().optional(),
  /** Max value as text (null when not measured). */
  max: z.string().nullable().optional(),
  /** A sentinel value (e.g. '-', 'N/A', '') detected in samples that means unknown/missing. */
  nullPlaceholder: z.string().optional(),

  // --- Temporality (Fix 3 + ADR-015; set by the temporality probes in node 1b) ---
  /**
   * Grain-type of a measure/state column, both species of as-of-event snapshot:
   * - `cumulative-snapshot` — a monotonic running total (SUM double-counts; use MAX/last-per-group).
   *   The compiler de-cumulates these (H2); only this value triggers that rewrite.
   * - `as-of-event-snapshot` — a non-monotonic state carried-forward as-of the event (e.g. a
   *   championship `position`/rank). Surfaced in the planner menu (ADR-013) as a grain distinguisher;
   *   NOT de-cumulated (it is a state, not a running sum) and never SUM-failed.
   */
  temporality: z.enum(['cumulative-snapshot', 'as-of-event-snapshot']).optional(),
  /** Structured evidence: the partition (entity + season) columns, the sequence order column, and a
   *  signal-specific metric. `ratio` (monotonic-non-decreasing fraction) is present for the monotonic
   *  signal; `vnRatio` (von Neumann ratio var(Δ)/var(v)) for the carry-forward signal (ADR-015). */
  temporalityEvidence: z
    .object({
      partitionColumns: z.array(z.string()),
      orderColumn: z.string(),
      /** How the tag was earned: the monotonic probe (cumulative) or the carry-forward probe (snapshot). */
      signal: z.enum(['monotonic', 'carry-forward']).optional(),
      /** Monotonic-non-decreasing fraction (monotonic signal only). */
      ratio: z.number().optional(),
      /** von Neumann ratio var(Δ)/var(v) (carry-forward signal only); lower ⇒ smoother snapshot. */
      vnRatio: z.number().optional(),
    })
    .optional(),
});
export type ColumnFact = z.infer<typeof ColumnFactSchema>;
