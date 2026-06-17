/**
 * Read-only `DbHandle` over PostgreSQL for the runner.
 *
 * Mirrors the READ ONLY discipline of src/storage/pg.ts `makePgConnector`
 * (`BEGIN TRANSACTION READ ONLY`) and the statement-timeout pattern used in
 * formula-validator.ts (`SET LOCAL statement_timeout`). One deliberate deviation,
 * documented: queries run with pg `rowMode: 'array'` so results are POSITIONAL tuples
 * with their `fields` for column order — the `Queryable` port returns keyed records,
 * which lose column order and collapse duplicate output-column names, both of which the
 * by-position matcher must not tolerate.
 *
 * Credentials come from the caller's connection string (env/compose), never hardcoded.
 */
import { Client, types as pgTypes } from 'pg';
import type { DbHandle, QueryResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Per-client type parsers (NOT global — avoids contaminating the rest of the repo's pg use).
 * pg returns int8 (OID 20) and numeric (OID 1700) as STRINGS by default to avoid precision
 * loss; psycopg2 returns them as Python int/Decimal that compare numerically. To make the
 * BIRD-faithful strict matcher (eval/src/match.ts) see numeric columns as numbers — so '1'
 * (text) stays text but 1 (numeric) is a number — we parse int8/numeric to JS Number here.
 * Precision caveat for values beyond 2^53 is documented in docs/eval.md.
 */
const NUMERIC_OIDS = [20, 1700, 700, 701]; // int8, numeric, float4, float8
function numericParsers(): { getTypeParser: typeof pgTypes.getTypeParser } {
  return {
    getTypeParser: ((oid: number, format?: unknown) => {
      if (NUMERIC_OIDS.includes(oid)) return (val: string) => (val === null ? null : Number(val));
      return (pgTypes.getTypeParser as (o: number, f?: unknown) => unknown)(oid, format);
    }) as typeof pgTypes.getTypeParser,
  };
}

function timeoutFromEnv(): number {
  const raw = Number(process.env.EVAL_STMT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

export interface ReadOnlyDb extends DbHandle {
  close(): Promise<void>;
}

/**
 * Open a read-only handle to `connectionString` for database `dbName`. The connection
 * stays in one READ ONLY transaction for its lifetime; every statement is timeout-bounded.
 */
export async function makeReadOnlyDbHandle(
  connectionString: string,
  dbName: string,
  statementTimeoutMs: number = timeoutFromEnv(),
): Promise<ReadOnlyDb> {
  const client = new Client({ connectionString, types: numericParsers() });
  await client.connect();
  await client.query('BEGIN TRANSACTION READ ONLY');
  await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
  return {
    dbName,
    async query(sql: string): Promise<QueryResult> {
      const res = await client.query({ text: sql, rowMode: 'array' });
      const columns = (res.fields ?? []).map((f) => f.name);
      const rows = (res.rows as unknown[][]) ?? [];
      return { columns, rows };
    },
    async close() {
      try {
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    },
  };
}
