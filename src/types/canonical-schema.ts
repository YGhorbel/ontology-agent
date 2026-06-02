/**
 * Engine-agnostic schema intermediate representation.
 *
 * Produced by node 1 (schema-ingest) from PostgreSQL `information_schema`, but
 * deliberately free of any PostgreSQL- or engine-specific shape so later sprints
 * (MySQL, Mongo, DuckDB) can populate the same structure. zod is the source of
 * truth; TypeScript types are inferred via `z.infer`.
 */
import { z } from 'zod';

/** A single relational column. */
export const ColumnSchema = z.object({
  name: z.string(),
  /** Canonical type string, e.g. "integer", "numeric", "text", "timestamp with time zone". */
  type: z.string(),
  nullable: z.boolean(),
  /** Raw default expression, or null when none. */
  default: z.string().nullable(),
  /** Column comment (from pg_description / COMMENT ON COLUMN), or null. */
  comment: z.string().nullable(),
  /** 1-based ordinal position within the table. */
  position: z.number().int().positive(),
});
export type Column = z.infer<typeof ColumnSchema>;

/** Cheap numeric statistics, seeded for downstream metric inference. */
export const NumericStatsSchema = z.object({
  column: z.string(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  avg: z.number().nullable(),
});
export type NumericStats = z.infer<typeof NumericStatsSchema>;

/** A foreign key edge, held at the top level for easy iteration by downstream nodes. */
export const ForeignKeySchema = z.object({
  /** Constraint name, used as a stable identifier for the derived relationship. */
  name: z.string(),
  sourceTable: z.string(),
  sourceColumn: z.string(),
  targetTable: z.string(),
  targetColumn: z.string(),
  /** Referential ON DELETE behavior as reported by the engine. */
  onDelete: z.string(),
});
export type ForeignKey = z.infer<typeof ForeignKeySchema>;

/** A table and everything we learned about it. */
export const TableSchema = z.object({
  name: z.string(),
  /** Table comment, or null. */
  comment: z.string().nullable(),
  columns: z.array(ColumnSchema).min(1),
  /** Up to 5 sample rows (anonymisable) to seed concept extraction. */
  sampleRows: z.array(z.record(z.string(), z.unknown())).max(5),
  numericStats: z.array(NumericStatsSchema),
});
export type Table = z.infer<typeof TableSchema>;

/** The full engine-agnostic schema for one datasource. */
export const CanonicalSchemaSchema = z.object({
  datasourceId: z.string(),
  tables: z.array(TableSchema),
  foreignKeys: z.array(ForeignKeySchema),
});
export type CanonicalSchema = z.infer<typeof CanonicalSchemaSchema>;
