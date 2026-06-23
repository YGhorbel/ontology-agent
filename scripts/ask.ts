/**
 * Smoke driver for the Stage-4 query pipeline.
 *
 *   pnpm ask "average lap time for British constructors"
 *
 * Builds the anchor index + ontology graph + capabilities ONCE from the committed
 * formula1 fixture, then runs the full S1→S2→S3a→S3b→execute flow and prints the
 * trace: terminals → payload joins → IR → SQL → rows (or the failure + which stage).
 *
 * Read-only. The planner uses the real LLM (needs an API key); execute runs only if
 * EVAL_FORMULA1_DSN is set (otherwise the SQL-only path is shown).
 */
import 'dotenv/config'; // load .env so the planner LLM can read OPENAI_API_KEY / AZURE_OPENAI_*
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAnchorIndex } from '../src/query/anchor-index.js';
import { buildGraph, loadCapabilities } from '../src/query/graph-build.js';
import { makeRealLlm } from '../src/llm/client.js';
import { runPipeline, type PipelineDeps } from '../src/query/pipeline.js';
import type { PruneTrace } from '../src/query/prune.js';

const FIXTURE = resolve(process.cwd(), 'eval/fixtures/ontologies/formula1-1781704520.jsonld');
const short = (iri: string): string => iri.replace(/^qsl:class\//, '');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Optional: --max-terminals N tightens S1's recall-favoring candidate set (the default broad
  // set can over-join into an intractable query; a smaller cap keeps the demo tractable).
  let maxTerminals: number | undefined;
  const mtIdx = argv.indexOf('--max-terminals');
  if (mtIdx !== -1) {
    maxTerminals = Number(argv[mtIdx + 1]);
    argv.splice(mtIdx, 2);
  }
  const question = argv.join(' ').trim();
  if (!question) {
    console.error('usage: pnpm ask [--max-terminals N] "<question>"');
    process.exit(2);
  }

  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  const deps: PipelineDeps = {
    index: buildAnchorIndex(raw),
    graph: buildGraph(raw, {}),
    capabilities: loadCapabilities(raw),
    llm: makeRealLlm(),
    ...(maxTerminals ? { anchorOpts: { maxTerminals } } : {}),
  };

  const dsn = process.env.EVAL_FORMULA1_DSN;
  let dbHandle: { close(): Promise<void> } | undefined;
  if (dsn) {
    const { makeReadOnlyDbHandle } = await import('../eval/src/db.js');
    const handle = await makeReadOnlyDbHandle(dsn, 'formula1');
    deps.db = handle;
    dbHandle = handle;
  }

  console.log(`\nQ: ${question}\n${'─'.repeat(60)}`);
  let res;
  try {
    res = await runPipeline(question, deps);
  } finally {
    await dbHandle?.close();
  }

  if (res.ok) {
    console.log('terminals :', res.anchorSet.terminals.map(short).join(', '));
    printPrune(res.traces.prune);
    console.log('payload   :', res.payload.classes.map((c) => short(c.iri)).join(', '), `(cost ${res.payload.totalCost})`);
    console.log('joins     :');
    for (const j of res.payload.joins) {
      console.log(`            ${short(j.from)} → ${short(j.to)} on ${j.on.map((p) => p.join('=')).join(', ')} [${j.provenance}]`);
    }
    console.log('IR        :', JSON.stringify(res.ir));
    console.log('SQL       :\n' + res.sql);
    if (res.rows) {
      console.log(`rows      : ${res.rows.length} (cols: ${(res.columns ?? []).join(', ')})`);
      for (const row of res.rows.slice(0, 10)) console.log('           ', JSON.stringify(row));
    } else {
      console.log('rows      : (skipped — set EVAL_FORMULA1_DSN to execute)');
    }
  } else {
    console.log(`FAILED at stage: ${res.failure.stage}  reason: ${res.failure.reason}`);
    if (res.failure.detail) console.log('detail    :', res.failure.detail);
    if (res.anchorSet) console.log('terminals :', res.anchorSet.terminals.map(short).join(', '));
    printPrune(res.traces.prune);
    if (res.payload) console.log('joins     :', res.payload.joins.map((j) => `${short(j.from)}→${short(j.to)}`).join(', '));
    console.log('traces    :', Object.keys(res.traces).join(', '));
  }
}

/** Dump the S1.5 prune trace: kept (with grounding kind) and dropped (with reason). */
function printPrune(prune: PruneTrace | undefined): void {
  if (!prune) return;
  console.log('prune kept:', prune.kept.map((t) => `${short(t)}[${prune.groundedBy[t]}]`).join(', ') || '(none)');
  console.log('prune drop:', prune.dropped.map((d) => `${short(d.iri)} (${d.reason})`).join(', ') || '(none)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
