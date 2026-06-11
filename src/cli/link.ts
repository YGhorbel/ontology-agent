/**
 * CLI entry point — schema-link a natural-language question against a generated
 * ontology (no LLM, no DB), then resolve the join plan for the linked tables.
 *
 *   tsx src/cli/link.ts --ontology out/ontology-formula1-XXXX.jsonld --query "total points for Ferrari"
 *   pnpm run link --ontology <file.jsonld> --query "<question>"
 *
 * Prints the typed QueryIntent (tables, measures, group dims, filters, ambiguities,
 * unresolved) as JSON, then feeds intent.tables to the join resolver and prints the
 * FROM/JOIN skeleton — the end-to-end NL → tables → JOIN demo.
 */
import 'dotenv/config'; // load .env so --llm can read AZURE_OPENAI_*/OPENAI_API_KEY
import { readFileSync } from 'node:fs';
import { OntologyJsonLdSchema } from '../types/ontology.js';
import { buildOntologyIndex } from '../query/ontology-index.js';
import { buildJoinGraph, resolveJoinPath } from '../query/join-graph.js';
import { parseEvidence } from '../query/evidence.js';
import { intentToSql, onSql } from '../query/intent-to-sql.js';
import { generateSqlWithLlm } from '../query/llm-sql.js';
import { resolveIntent, pickHint } from '../query/llm-intent.js';
import { buildFocusedGrounding } from '../query/grounding.js';
import { makeRealLlm } from '../llm/client.js';
import type { StructuredLlm } from '../llm/structured-llm.js';
import type { LinkHints } from '../types/query-intent.js';

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).some((a) => a === flag);
}

function parseArg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a?.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

/** Parse a clarification pick "span=table.column" into an alias hint. */
function parsePick(arg: string): LinkHints | undefined {
  const eq = arg.indexOf('=');
  if (eq < 0) return undefined;
  const span = arg.slice(0, eq).trim();
  const target = arg.slice(eq + 1).trim();
  if (!span || !target) return undefined;
  const dot = target.lastIndexOf('.');
  const ref = dot > 0 ? { table: target.slice(0, dot), column: target.slice(dot + 1) } : { table: target };
  return pickHint(span, ref);
}

async function main(): Promise<number> {
  const ontologyPath = parseArg('--ontology');
  const query = parseArg('--query');
  if (!ontologyPath || !query) {
    console.error('Usage: tsx src/cli/link.ts --ontology <file.jsonld> --query "<question>" [--evidence "<hints>"] [--pick "span=table.column"] [--llm] [--verbose]');
    return 2;
  }

  const raw = JSON.parse(readFileSync(ontologyPath, 'utf8')) as unknown;
  const ontology = OntologyJsonLdSchema.parse(raw);
  const index = buildOntologyIndex(ontology);

  // Hints: BIRD evidence and/or a clarification pick (--pick "span=table.column").
  const evidence = parseArg('--evidence');
  let hints: LinkHints | undefined = evidence ? parseEvidence(evidence, index).hints : undefined;
  const pickArg = parseArg('--pick');
  if (pickArg) {
    const ph = parsePick(pickArg);
    if (ph) hints = hints ? { ...hints, aliases: [...hints.aliases, ...ph.aliases] } : ph;
    else console.error(`[pick] could not parse "${pickArg}" (expected span=table.column)`);
  }

  // Build the LLM only when --llm, so the intent tier can fall through to it on weak intent.
  let llm: StructuredLlm | null = null;
  if (hasFlag('--llm')) {
    try { llm = makeRealLlm(); } catch (err) { console.error(`[llm] init failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  // --verbose narrates the retrieve → llm → validate steps (to stderr, off the JSON stdout).
  const verbose = hasFlag('--verbose') || hasFlag('-v');
  const log = verbose ? (m: string): void => console.error(`-- [intent] ${m}`) : undefined;
  const resolved = await resolveIntent(query, index, { ...(llm ? { llm } : {}), ...(hints ? { hints } : {}), ...(log ? { log } : {}) });
  const intent = resolved.intent;
  console.log(`-- intent source: ${resolved.source}`);
  for (const w of resolved.warnings ?? []) console.log(`-- warn: ${w}`);
  if (resolved.error) console.error(`-- [llm] ${resolved.error}`);
  console.log(JSON.stringify(intent, null, 2));
  if (resolved.clarification) {
    const c = resolved.clarification;
    console.log(`\n-- ⚠ clarify: ${c.question}`);
    c.options.forEach((o, i) => console.log(`--   ${i + 1}) ${o.table}${o.column ? `.${o.column}` : ''}`));
    console.log(`-- resolve with: --pick "${c.span}=<table.column>"`);
  }

  // Resolve the join plan for the linked tables, then synthesize the SQL.
  if (intent.tables.length >= 1) {
    const graph = buildJoinGraph(index.joinEdges);
    const factTables = index.capabilities.filter((c) => c.kind === 'factTable').map((c) => c.scopeTable);
    const plan = resolveJoinPath(graph, intent.tables, { factTables });
    if (intent.tables.length >= 2) {
      console.log(`\nFROM ${plan.anchorTable}`);
      for (const c of plan.clauses) {
        const fan = c.multiplies ? ' [fan-out]' : '';
        console.log(`JOIN ${c.joinTable} ON ${onSql(c)}   -- ${c.cardinality}, ${c.provenance} ${c.confidence.toFixed(2)}${fan}`);
      }
      if (plan.unreachable.length > 0) console.log(`\n[!] unreachable: ${plan.unreachable.join(', ')}`);
    }
    const { sql, warnings } = intentToSql(intent, plan, index);
    console.log(`\n-- SQL (deterministic)\n${sql}`);
    for (const w of warnings) console.log(`-- note: ${w}`);
  }

  // Grounded LLM SQL-tier fallback (--llm): for analytics the typed intent can't express
  // (percentages, subqueries, windows). The intent tier above is the primary LLM path.
  if (hasFlag('--llm')) {
    // Show the token reduction up front (visible even without an API key).
    const { stats } = buildFocusedGrounding(query, index);
    console.log(`\n-- grounding: ${stats.sliceTokens} tok (-${stats.reductionPct}% vs full ${stats.fullTokens})`);
    if (llm) {
      try {
        const out = await generateSqlWithLlm(query, index, llm);
        console.log(`-- SQL (LLM SQL-tier fallback)\n${out.sql}`);
        console.log(`-- rationale: ${out.rationale}`);
      } catch (err) {
        console.error(`\n[llm] failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return intent.tables.length > 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
