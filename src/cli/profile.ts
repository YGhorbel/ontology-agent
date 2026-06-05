/**
 * CLI entry point — data profiling.
 *
 *   npx tsx src/cli/profile.ts --dsn "postgres://user:pass@host:5432/db" --single
 *   pnpm run profile --dsn "postgres://..." --single --keys
 *
 * NOTE: use `pnpm run profile` (not `pnpm profile`) — `profile` is a reserved
 * npm/pnpm built-in command, so the bare form would not run this script.
 *
 * Connects READ ONLY to the given datasource, introspects its schema, and runs the
 * requested profiling mode(s); writes nothing — output is stdout only.
 *
 *   --single  per-column metrics (data type, num-rows, null count, distinct count,
 *             uniqueness ratio, min, max) grouped by table.
 *   --keys    uniqueness / key discovery (§5.1): the unique column-sets that are
 *             legal relationship target sides, tagged declared-vs-discovered.
 *
 * At least one mode is required; both may be combined.
 */
import 'dotenv/config';
import { makePgConnector } from '../storage/pg.js';
import { introspect } from '../agent/nodes/01-schema-ingest.js';
import { profileSchema } from '../profiling/single-column.js';
import { discoverKeys } from '../profiling/key-discovery.js';
import type { ColumnProfile } from '../types/column-profile.js';
import type { KeyCandidate } from '../types/key-candidate.js';

function parseArg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a?.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

const hasFlag = (flag: string): boolean => process.argv.slice(2).includes(flag);

const pct = (r: number | null): string => (r === null ? '-' : `${Math.round(r * 100)}%`);
const trunc = (s: string | null): string =>
  s === null ? '-' : s.length > 24 ? `${s.slice(0, 23)}…` : s;

/** Flatten one profile into the printable row shown by console.table. */
const toRow = (p: ColumnProfile) => ({
  column: p.column,
  type: p.dataType,
  rows: p.numRows,
  nulls: p.nullCount,
  'null%': pct(p.nullRatio),
  distinct: p.distinctCount ?? '-',
  'unique%': pct(p.uniquenessRatio),
  min: trunc(p.min),
  max: trunc(p.max),
});

/** Flatten one key candidate into the printable row shown by console.table. */
const keyRow = (k: KeyCandidate) => ({
  columns: k.columns.join('+'),
  unique: k.unique,
  certain: k.certain,
  minimal: k.minimal,
  declared: k.declared ?? '-',
  method: k.method,
  distinct: k.distinctCount ?? '-',
  rows: k.numRows,
});

async function main(): Promise<number> {
  const dsn = parseArg('--dsn') ?? process.env.ONTOLOGY_TARGET_DSN;
  if (!dsn) {
    console.error('Usage: tsx src/cli/profile.ts --dsn <connection-string> --single');
    console.error('  (--dsn may be omitted if ONTOLOGY_TARGET_DSN is set)');
    return 2;
  }
  const single = hasFlag('--single');
  const keys = hasFlag('--keys');
  if (!single && !keys) {
    console.error('Specify a profiling mode: --single and/or --keys');
    return 2;
  }

  const client = await makePgConnector(dsn);
  try {
    const schema = await introspect(client, 'profile');
    const profiles = await profileSchema(client, schema);

    if (single) {
      for (const table of schema.tables) {
        const rows = profiles.filter((p) => p.table === table.name).map(toRow);
        console.log(`\nTable: ${table.name}  (${rows.length} columns)`);
        console.table(rows);
      }
      console.log(`\nProfiled ${schema.tables.length} table(s), ${profiles.length} column(s).`);
    }

    if (keys) {
      const candidates = await discoverKeys(client, schema, profiles);
      for (const table of schema.tables) {
        const rows = candidates.filter((k) => k.table === table.name).map(keyRow);
        console.log(`\nKeys: ${table.name}  (${rows.length} key candidate(s))`);
        console.table(rows);
      }
      console.log(`\nDiscovered ${candidates.length} key candidate(s) across ${schema.tables.length} table(s).`);
    }
    return 0;
  } finally {
    await client.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[profile] FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
