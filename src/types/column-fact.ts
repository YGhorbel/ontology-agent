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
  /** The column is a single-column unique key. */
  isUnique: z.boolean(),
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

  // --- Temporality (Fix 3; set by the monotonicity probe in node 1b) ---
  /** Cumulative running-total measure → SUM double-counts; use MAX / last-value-per-group. */
  temporality: z.enum(['cumulative-snapshot']).optional(),
  /** String evidence: partition/order columns + observed monotonic ratio. */
  temporalityEvidence: z.string().optional(),
});
export type ColumnFact = z.infer<typeof ColumnFactSchema>;
