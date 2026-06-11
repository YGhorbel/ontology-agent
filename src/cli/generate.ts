/**
 * CLI entry point.
 *
 *   # target DB by connection string (id derived from the DB name):
 *   npx tsx src/cli/generate.ts --dsn "postgresql://user:pass@host:5432/ecommerce"
 *   # or give an explicit id:
 *   npx tsx src/cli/generate.ts --dsn "postgresql://..." --datasource ecommerce
 *   # or rely on ONTOLOGY_TARGET_DSN from the environment:
 *   npx tsx src/cli/generate.ts --datasource ecommerce
 *
 * Runs the LangGraph pipeline against the target DSN (`--dsn` or
 * ONTOLOGY_TARGET_DSN), writes the JSON-LD to OUT_DIR, persists fragments to the
 * ontology store (DATABASE_URL), records the run, prints a summary, and exits
 * non-zero if validation did not pass.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { buildProductionGraph } from '../agent/graph.js';
import { createOntologyStore, type RunStatus } from '../storage/ontology-store.js';
import { toTrig } from '../serialize/turtle.js';
import { partitionDataset } from '../agent/assemble.js';
import { buildOntologyHeader } from '../serialize/ontology-header.js';
import type { OntologyDataset, OntologyJsonLd } from '../types/ontology.js';

function parseArg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a?.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

/** Derive a stable datasource id from a connection string's database name. */
function datasourceIdFromDsn(dsn: string): string | undefined {
  try {
    const db = new URL(dsn).pathname.replace(/^\//, '').trim();
    return db.length > 0 ? db : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const targetDsn = parseArg('--dsn') ?? process.env.ONTOLOGY_TARGET_DSN;
  if (!targetDsn) {
    console.error('Usage: tsx src/cli/generate.ts --dsn <connection-string> [--datasource <id>]');
    console.error('  (--dsn may be omitted if ONTOLOGY_TARGET_DSN is set)');
    return 2;
  }

  // Id is the output/persistence label: explicit flag wins, else derive from the DSN db name.
  const datasourceId = parseArg('--datasource') ?? datasourceIdFromDsn(targetDsn);
  if (!datasourceId) {
    console.error('Could not derive a datasource id from --dsn; pass --datasource <id> explicitly.');
    return 2;
  }

  const storeDsn = process.env.DATABASE_URL;
  if (!storeDsn) {
    console.error('Missing DATABASE_URL (the ontology store; see .env.example).');
    return 2;
  }

  const outDir = resolve(process.env.OUT_DIR ?? 'out');
  const startedAt = new Date();
  const store = createOntologyStore(storeDsn);

  try {
    console.log(`[ontology-generator] Generating ontology for datasource "${datasourceId}"...`);
    const graph = buildProductionGraph();
    const final = await graph.invoke(
      { datasourceId, pgConnectionString: targetDsn },
      { runName: 'ontology-generate', tags: ['ontology-agent'], metadata: { datasourceId } },
    );

    const ontology = final.ontology as OntologyJsonLd | null;
    const validationErrors = final.validationErrors ?? [];
    if (!ontology) throw new Error('Pipeline produced no ontology.');

    // Tier into asserted + candidate graphs and attach the reproducibility header (Fix 5/6).
    const exportMode = (parseArg('--export') ?? 'full').toLowerCase();
    if (exportMode !== 'full' && exportMode !== 'asserted') {
      console.error('--export must be "asserted" or "full".');
      return 2;
    }
    const { assertedGraph, candidateGraph } = partitionDataset(ontology);
    const header = buildOntologyHeader({
      datasourceId,
      dsn: targetDsn,
      schemaList: ['public'],
      generatorVersion: process.env.npm_package_version ?? '0.1.0',
      buildNumber: Number(process.env.ONTOLOGY_BUILD_NUMBER) || Math.floor(startedAt.getTime() / 1000),
      createdIso: startedAt.toISOString(),
    });
    const dataset: OntologyDataset = {
      '@context': ontology['@context'],
      'qsl:ontology': header,
      '@graph': assertedGraph,
      ...(exportMode === 'full' && candidateGraph.length > 0 ? { 'qsl:candidateGraph': candidateGraph } : {}),
    };

    // Write JSON-LD dataset + TriG (asserted default graph + named candidate graph).
    mkdirSync(outDir, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const outPath = resolve(outDir, `ontology-${datasourceId}-${stamp}.jsonld`);
    writeFileSync(outPath, JSON.stringify(dataset, null, 2), 'utf8');
    const ttlPath = resolve(outDir, `ontology-${datasourceId}-${stamp}.trig`);
    writeFileSync(ttlPath, toTrig(dataset, datasourceId), 'utf8');

    // Persist fragments + run record.
    await store.applyDdl();
    const fragmentCount = await store.persistOntology(datasourceId, ontology);
    const status: RunStatus = validationErrors.length === 0 ? 'success' : 'partial';
    await store.recordRun({
      datasourceId,
      startedAt,
      finishedAt: new Date(),
      fragmentCount,
      status,
      error: validationErrors.length > 0 ? JSON.stringify(validationErrors) : null,
    });

    // Summary.
    console.log(`\n=== Ontology generation ${status.toUpperCase()} ===`);
    console.log(`JSON-LD written to:   ${outPath}`);
    console.log(`TriG written to:      ${ttlPath}`);
    console.log(`Export profile:       ${exportMode} (asserted ${assertedGraph.length} nodes, candidate ${candidateGraph.length} edges)`);
    console.log(`Fragments persisted:  ${fragmentCount} (datasource_id='${datasourceId}')`);
    console.log(`Validation errors:    ${validationErrors.length}`);
    console.log(`Retries used:         ${final.retryCount}`);
    console.log(`\nInspect with:\n  SELECT fragment_kind, pref_label FROM ontology_fragment WHERE datasource_id='${datasourceId}' ORDER BY fragment_kind;`);
    if (process.env.LANGSMITH_PROJECT || process.env.LANGCHAIN_PROJECT) {
      console.log(`\nLangSmith project: ${process.env.LANGSMITH_PROJECT ?? process.env.LANGCHAIN_PROJECT}`);
    }
    if (validationErrors.length > 0) {
      console.warn('\nValidation did not pass after retries — persisted partial ontology:');
      for (const e of validationErrors) console.warn(`  - [${e.rule}] ${e.subject}: ${e.message}`);
      return 1;
    }
    return 0;
  } catch (err) {
    await store
      .recordRun({
        datasourceId,
        startedAt,
        finishedAt: new Date(),
        fragmentCount: 0,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => undefined);
    console.error('[ontology-generator] FAILED:', err instanceof Error ? err.message : err);
    return 1;
  } finally {
    await store.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
