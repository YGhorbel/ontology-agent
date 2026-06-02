/**
 * PostgreSQL persistence for generated ontologies.
 *
 * Applies the DDL idempotently, upserts each JSON-LD `@graph` node into
 * `ontology_fragment` (unique on datasource_id + fragment_iri), and records an
 * `ontology_run` row. Connects to the ontology store DB (DATABASE_URL), distinct
 * from the introspected target datasource.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { GraphNode, OntologyJsonLd } from '../types/ontology.js';

const DDL = readFileSync(fileURLToPath(new URL('./ddl.sql', import.meta.url)), 'utf8');

const KIND_BY_TYPE: Record<string, string> = {
  'owl:Class': 'Class',
  'owl:DatatypeProperty': 'DatatypeProperty',
  'owl:ObjectProperty': 'ObjectProperty',
  'qsl:Capability': 'Capability',
};

interface FragmentRow {
  iri: string;
  kind: string;
  prefLabel: string | null;
  altLabels: string[];
  mapsToTable: string | null;
  mapsToColumn: string | null;
  content: GraphNode;
}

function toFragmentRow(node: GraphNode): FragmentRow {
  const rec = node as Record<string, unknown>;
  const prefLabel =
    typeof rec['skos:prefLabel'] === 'string'
      ? (rec['skos:prefLabel'] as string)
      : typeof rec['rdfs:label'] === 'string'
        ? (rec['rdfs:label'] as string)
        : null;
  const altLabels = Array.isArray(rec['skos:altLabel']) ? (rec['skos:altLabel'] as string[]) : [];
  return {
    iri: node['@id'],
    kind: KIND_BY_TYPE[node['@type']] ?? node['@type'],
    prefLabel,
    altLabels,
    mapsToTable: typeof rec['qsl:mapsToTable'] === 'string' ? (rec['qsl:mapsToTable'] as string) : null,
    mapsToColumn: typeof rec['qsl:mapsToColumn'] === 'string' ? (rec['qsl:mapsToColumn'] as string) : null,
    content: node,
  };
}

export type RunStatus = 'success' | 'failed' | 'partial';

export interface OntologyStore {
  applyDdl(): Promise<void>;
  persistOntology(datasourceId: string, ontology: OntologyJsonLd): Promise<number>;
  recordRun(input: {
    datasourceId: string;
    startedAt: Date;
    finishedAt: Date;
    fragmentCount: number;
    status: RunStatus;
    error?: string | null;
  }): Promise<void>;
  countFragments(datasourceId: string): Promise<number>;
  close(): Promise<void>;
}

export function createOntologyStore(connectionString: string): OntologyStore {
  const pool = new Pool({ connectionString });
  return {
    async applyDdl() {
      await pool.query(DDL);
    },

    async persistOntology(datasourceId, ontology) {
      const rows = ontology['@graph'].map(toFragmentRow);
      for (const r of rows) {
        await pool.query(
          `INSERT INTO ontology_fragment
             (datasource_id, fragment_iri, fragment_kind, pref_label, alt_labels,
              content_jsonld, maps_to_table, maps_to_column)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (datasource_id, fragment_iri) DO UPDATE SET
             fragment_kind = EXCLUDED.fragment_kind,
             pref_label    = EXCLUDED.pref_label,
             alt_labels    = EXCLUDED.alt_labels,
             content_jsonld = EXCLUDED.content_jsonld,
             maps_to_table  = EXCLUDED.maps_to_table,
             maps_to_column = EXCLUDED.maps_to_column`,
          [
            datasourceId,
            r.iri,
            r.kind,
            r.prefLabel,
            r.altLabels,
            JSON.stringify(r.content),
            r.mapsToTable,
            r.mapsToColumn,
          ],
        );
      }
      return rows.length;
    },

    async recordRun(input) {
      await pool.query(
        `INSERT INTO ontology_run
           (datasource_id, started_at, finished_at, fragment_count, status, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.datasourceId,
          input.startedAt.toISOString(),
          input.finishedAt.toISOString(),
          input.fragmentCount,
          input.status,
          input.error ?? null,
        ],
      );
    },

    async countFragments(datasourceId) {
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS count FROM ontology_fragment WHERE datasource_id = $1',
        [datasourceId],
      );
      const row = rows[0] as { count: number } | undefined;
      return row?.count ?? 0;
    },

    async close() {
      await pool.end();
    },
  };
}
