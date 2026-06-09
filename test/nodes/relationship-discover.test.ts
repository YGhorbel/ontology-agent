import { describe, it, expect } from 'vitest';
import { createRelationshipDiscoverNode } from '../../src/agent/nodes/01b-relationship-discover.js';
import type { Queryable, SchemaConnector } from '../../src/storage/pg.js';
import type { CanonicalSchema } from '../../src/types/canonical-schema.js';
import type { OntologyState } from '../../src/agent/state.js';

/** Tiny two-table schema: posts.user_id is an undeclared FK into users.id. */
const miniSchema = {
  datasourceId: 'mini',
  tables: [
    {
      name: 'users',
      comment: null,
      columns: [{ name: 'id', type: 'integer', nullable: false, default: null, comment: null, position: 1 }],
      sampleRows: [],
      numericStats: [],
    },
    {
      name: 'posts',
      comment: null,
      columns: [
        { name: 'id', type: 'integer', nullable: false, default: null, comment: null, position: 1 },
        { name: 'user_id', type: 'integer', nullable: false, default: null, comment: null, position: 2 },
      ],
      sampleRows: [],
      numericStats: [],
    },
  ],
  foreignKeys: [],
} as CanonicalSchema;

/**
 * Connector whose Queryable answers the four profiling query shapes for
 * `miniSchema`: the IND posts.user_id ⊆ users.id holds; every other candidate
 * pair fails containment.
 */
function discoverConnector(): SchemaConnector {
  const queryable: Queryable = {
    async query(text: string) {
      const t = text.trim();
      if (t.includes('count(DISTINCT (')) return { rows: [{ n: 3, k0: 2 }] }; // composite probe → not unique
      if (t.includes('information_schema.table_constraints')) return { rows: [] }; // no declared keys
      if (/FROM "users"$/.test(t) && t.includes('count(*) AS n')) {
        return { rows: [{ n: 3, c0__nn: 3, c0__d: 3, c0__min: '1', c0__max: '3' }] }; // users.id unique
      }
      if (/FROM "posts"$/.test(t) && t.includes('count(*) AS n')) {
        return { rows: [{ n: 3, c0__nn: 3, c0__d: 3, c0__min: '1', c0__max: '3', c1__nn: 3, c1__d: 2, c1__min: '1', c1__max: '2' }] };
      }
      if (t.includes('AS src_distinct')) {
        const src = /SELECT DISTINCT "([^"]+)" AS v FROM "([^"]+)"/.exec(t);
        const tgt = /LEFT JOIN \(SELECT DISTINCT "[^"]+" AS v FROM "([^"]+)"\)/.exec(t);
        const holds = src?.[2] === 'posts' && src?.[1] === 'user_id' && tgt?.[1] === 'users';
        return { rows: [{ src_distinct: 2, missing: holds ? 0 : 1 }] };
      }
      if (t.includes('::text AS v')) return { rows: [] }; // value-dictionary sample (column-facts)
      throw new Error(`discoverConnector: unexpected query: ${t}`);
    },
  };
  return (async () => ({ ...queryable, close: async () => undefined })) as SchemaConnector;
}

describe('createRelationshipDiscoverNode', () => {
  it('runs the profiling pipeline and surfaces the undeclared FK as a candidate', async () => {
    const node = createRelationshipDiscoverNode(discoverConnector());
    const update = await node({ canonicalSchema: miniSchema, pgConnectionString: 'x' } as OntologyState);

    const fks = update.foreignKeyCandidates ?? [];
    const found = fks.find((f) => f.sourceTable === 'posts' && f.sourceColumn === 'user_id' && f.targetTable === 'users');
    expect(found).toBeDefined();
    expect(found?.verified).toBe(true);
    expect(found?.declared).toBe(false);
    expect(found?.score).toBeGreaterThanOrEqual(0.8); // name-matching undeclared FK
  });

  it('throws when canonicalSchema is missing (node 1 did not run)', async () => {
    const node = createRelationshipDiscoverNode(discoverConnector());
    await expect(node({ canonicalSchema: null } as OntologyState)).rejects.toThrow(/canonicalSchema is missing/);
  });
});
