/**
 * Node 1 — Schema Ingester (deterministic, no LLM).
 *
 * Reads PostgreSQL `information_schema` / `pg_description` in one READ ONLY
 * transaction and produces the engine-agnostic `CanonicalSchema`: tables (+ comments),
 * columns (+ comments/types/defaults), foreign keys, up to 5 sample rows per table,
 * and cheap min/max/avg stats per numeric column.
 */
import type { SchemaConnector, Queryable } from '../../storage/pg.js';
import {
  CanonicalSchemaSchema,
  type CanonicalSchema,
  type Column,
  type ForeignKey,
  type NumericStats,
  type Table,
} from '../../types/canonical-schema.js';
import type { OntologyState, OntologyStateUpdate } from '../state.js';

const NUMERIC_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'decimal',
  'real',
  'double precision',
]);

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`;

async function readColumns(q: Queryable): Promise<Map<string, Column[]>> {
  const { rows } = await q.query(
    `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default,
            c.ordinal_position,
            col_description(to_regclass(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name)),
                            c.ordinal_position) AS column_comment
       FROM information_schema.columns c
      WHERE c.table_schema = 'public'
      ORDER BY c.table_name, c.ordinal_position`,
  );
  const byTable = new Map<string, Column[]>();
  for (const r of rows) {
    const table = String(r['table_name']);
    const col: Column = {
      name: String(r['column_name']),
      type: String(r['data_type']),
      nullable: String(r['is_nullable']).toUpperCase() === 'YES',
      default: str(r['column_default']),
      comment: str(r['column_comment']),
      position: Number(r['ordinal_position']),
    };
    const list = byTable.get(table) ?? [];
    list.push(col);
    byTable.set(table, list);
  }
  return byTable;
}

async function readForeignKeys(q: Queryable): Promise<ForeignKey[]> {
  const { rows } = await q.query(
    `SELECT tc.constraint_name, tc.table_name AS source_table, kcu.column_name AS source_column,
            ccu.table_name AS target_table, ccu.column_name AS target_column, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
  );
  return rows.map((r) => ({
    name: String(r['constraint_name']),
    sourceTable: String(r['source_table']),
    sourceColumn: String(r['source_column']),
    targetTable: String(r['target_table']),
    targetColumn: String(r['target_column']),
    onDelete: String(r['delete_rule']),
  }));
}

async function readSampleRows(q: Queryable, table: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await q.query(`SELECT * FROM ${quoteIdent(table)} LIMIT 5`);
  return rows;
}

async function readNumericStats(q: Queryable, table: string, columns: Column[]): Promise<NumericStats[]> {
  const numericCols = columns.filter((c) => NUMERIC_TYPES.has(c.type));
  if (numericCols.length === 0) return [];
  const selects = numericCols
    .map(
      (c) =>
        `min(${quoteIdent(c.name)})::float8 AS ${quoteIdent(`${c.name}__min`)},` +
        `max(${quoteIdent(c.name)})::float8 AS ${quoteIdent(`${c.name}__max`)},` +
        `avg(${quoteIdent(c.name)})::float8 AS ${quoteIdent(`${c.name}__avg`)}`,
    )
    .join(',');
  const { rows } = await q.query(`SELECT ${selects} FROM ${quoteIdent(table)}`);
  const row = rows[0] ?? {};
  return numericCols.map((c) => ({
    column: c.name,
    min: num(row[`${c.name}__min`]),
    max: num(row[`${c.name}__max`]),
    avg: num(row[`${c.name}__avg`]),
  }));
}

/** Pure introspection routine, exported for direct unit testing with a fake Queryable. */
export async function introspect(q: Queryable, datasourceId: string): Promise<CanonicalSchema> {
  const tableRows = await q.query(
    `SELECT t.table_name,
            obj_description(to_regclass(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name)),
                            'pg_class') AS table_comment
       FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name`,
  );
  const columnsByTable = await readColumns(q);
  const foreignKeys = await readForeignKeys(q);

  const tables: Table[] = [];
  for (const r of tableRows.rows) {
    const name = String(r['table_name']);
    const columns = columnsByTable.get(name) ?? [];
    tables.push({
      name,
      comment: str(r['table_comment']),
      columns,
      sampleRows: await readSampleRows(q, name),
      numericStats: await readNumericStats(q, name, columns),
    });
  }

  return CanonicalSchemaSchema.parse({ datasourceId, tables, foreignKeys });
}

/** Factory: binds the connector so tests can inject a fake. */
export function createSchemaIngestNode(connect: SchemaConnector) {
  return async function schemaIngest(state: OntologyState): Promise<OntologyStateUpdate> {
    const client = await connect(state.pgConnectionString);
    try {
      const canonicalSchema = await introspect(client, state.datasourceId);
      return { canonicalSchema };
    } finally {
      await client.close();
    }
  };
}
