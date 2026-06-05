/**
 * Single-column data profile: the cheap per-column statistics that feed
 * foreign-key / inclusion-dependency discovery.
 *
 * Grounded in Abedjan, Golab & Naumann, "Profiling relational data: a survey"
 * (VLDB Journal 2015), §3.1/§3.3. Foreign-key discovery there decomposes into
 * inclusion-dependency + uniqueness discovery; both consume these single-column
 * metrics. zod is the source of truth; the TypeScript type is inferred.
 *
 * Produced by `src/profiling/single-column.ts`; not yet wired into the agent
 * graph (the relationship-discovery axes will consume it).
 */
import { z } from 'zod';

export const ColumnProfileSchema = z.object({
  table: z.string(),
  column: z.string(),
  /** Canonical type string copied from `Column.type` (e.g. "integer", "uuid"). §3.3 prefilter. */
  dataType: z.string(),
  /** count(*) — the denominator for null/uniqueness ratios. §3.1. */
  numRows: z.number().int().nonnegative(),
  /** numRows - count(col). §3.1; all-null columns are discovery junk. */
  nullCount: z.number().int().nonnegative(),
  /** nullCount / numRows, in [0,1]; 0 for an empty table. */
  nullRatio: z.number().min(0).max(1),
  /**
   * count(DISTINCT col); the costly metric (needs hash/sort). §3.1.
   * null when the column's type is not safely profilable (e.g. json/xml/array).
   */
  distinctCount: z.number().int().nonnegative().nullable(),
  /**
   * distinctCount / numRows, in [0,1]. ≈1.0 ⇒ key candidate ⇒ valid FK target. §3.1.
   * null when numRows === 0 or distinctCount was not computed.
   */
  uniquenessRatio: z.number().min(0).max(1).nullable(),
  /** min(col)::text — instant negative range test. §3.1. null when uncomputed/empty. */
  min: z.string().nullable(),
  /** max(col)::text — instant negative range test. §3.1. null when uncomputed/empty. */
  max: z.string().nullable(),
});
export type ColumnProfile = z.infer<typeof ColumnProfileSchema>;
