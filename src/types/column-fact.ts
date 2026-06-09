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
});
export type ColumnFact = z.infer<typeof ColumnFactSchema>;
