/**
 * CLI entry point — single-column data profiling.
 *
 *   npx tsx src/cli/profile.ts --dsn "postgres://user:pass@host:5432/db" --single
 *   pnpm run profile --dsn "postgres://..." --single
 *
 * NOTE: use `pnpm run profile` (not `pnpm profile`) — `profile` is a reserved
 * npm/pnpm built-in command, so the bare form would not run this script.
 *
 * Connects READ ONLY to the given datasource, introspects its schema, runs the
 * single-column profiler, and prints the six per-column metrics (data type,
 * num-rows, null count, distinct count, uniqueness ratio, min, max) grouped by
 * table. Writes nothing — output is stdout only.
 *
 * `--single` selects single-column profiling (the only mode today; the flag keeps
 * room for future modes such as multi-column / inclusion-dependency profiling).
 */
import 'dotenv/config';
import { makePgConnector } from '../storage/pg.js';
import { introspect } from '../agent/nodes/01-schema-ingest.js';
import { profileSchema } from '../profiling/single-column.js';
import type { ColumnProfile } from '../types/column-profile.js';

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

async function main(): Promise<number> {
  const dsn = parseArg('--dsn') ?? process.env.ONTOLOGY_TARGET_DSN;
  if (!dsn) {
    console.error('Usage: tsx src/cli/profile.ts --dsn <connection-string> --single');
    console.error('  (--dsn may be omitted if ONTOLOGY_TARGET_DSN is set)');
    return 2;
  }
  if (!hasFlag('--single')) {
    console.error('Specify a profiling mode: --single');
    return 2;
  }

  const client = await makePgConnector(dsn);
  try {
    const schema = await introspect(client, 'profile');
    const profiles = await profileSchema(client, schema);

    for (const table of schema.tables) {
      const rows = profiles.filter((p) => p.table === table.name).map(toRow);
      console.log(`\nTable: ${table.name}  (${rows.length} columns)`);
      console.table(rows);
    }
    console.log(`\nProfiled ${schema.tables.length} table(s), ${profiles.length} column(s).`);
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
