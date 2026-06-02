/**
 * CLI entry point.
 *
 *   npx tsx src/cli/generate.ts --datasource ecommerce
 *
 * Runs the LangGraph pipeline against ONTOLOGY_TARGET_DSN, writes the JSON-LD to
 * OUT_DIR, persists fragments to the ontology store (DATABASE_URL), records the
 * run, prints a summary, and exits non-zero if validation did not pass.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { buildProductionGraph } from '../agent/graph.js';
import { createOntologyStore, type RunStatus } from '../storage/ontology-store.js';
import { toTurtle } from '../serialize/turtle.js';
import type { OntologyJsonLd } from '../types/ontology.js';

function parseArg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a?.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

async function main(): Promise<number> {
  const datasourceId = parseArg('--datasource');
  if (!datasourceId) {
    console.error('Usage: tsx src/cli/generate.ts --datasource <id>');
    return 2;
  }

  const targetDsn = process.env.ONTOLOGY_TARGET_DSN;
  const storeDsn = process.env.DATABASE_URL;
  if (!targetDsn || !storeDsn) {
    console.error('Missing ONTOLOGY_TARGET_DSN and/or DATABASE_URL (see .env.example).');
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

    // Write JSON-LD + Turtle output.
    mkdirSync(outDir, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const outPath = resolve(outDir, `ontology-${datasourceId}-${stamp}.jsonld`);
    writeFileSync(outPath, JSON.stringify(ontology, null, 2), 'utf8');
    const ttlPath = resolve(outDir, `ontology-${datasourceId}-${stamp}.ttl`);
    writeFileSync(ttlPath, toTurtle(ontology, datasourceId), 'utf8');

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
    console.log(`Turtle written to:    ${ttlPath}`);
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
