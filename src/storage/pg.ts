/**
 * Thin PostgreSQL connection helpers and the `Queryable` port.
 *
 * Node 1 (schema-ingest) depends only on `IntrospectionClient`, so unit tests can
 * inject a fake connector that returns canned `information_schema` rows — no real
 * database, no Docker.
 */
import { Client } from 'pg';

/** Minimal query surface; rows are untyped maps validated at the call site. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A queryable that owns a connection and can release it. */
export interface IntrospectionClient extends Queryable {
  close(): Promise<void>;
}

/** Opens a connection to a datasource for read-only introspection. */
export type SchemaConnector = (connectionString: string) => Promise<IntrospectionClient>;

/** Real connector: a pg Client running in a READ ONLY transaction. */
export const makePgConnector: SchemaConnector = async (connectionString) => {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query('BEGIN TRANSACTION READ ONLY');
  return {
    async query(text, params) {
      const res = await client.query(text, params);
      return { rows: res.rows as Array<Record<string, unknown>> };
    },
    async close() {
      try {
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    },
  };
};
