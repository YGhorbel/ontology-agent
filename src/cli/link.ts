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
import { readFileSync } from 'node:fs';
import { OntologyJsonLdSchema } from '../types/ontology.js';
import { buildOntologyIndex } from '../query/ontology-index.js';
import { buildJoinGraph, resolveJoinPath } from '../query/join-graph.js';
import { linkQuestion } from '../query/schema-linker.js';
import { parseEvidence } from '../query/evidence.js';

function parseArg(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a?.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

function main(): number {
  const ontologyPath = parseArg('--ontology');
  const query = parseArg('--query');
  if (!ontologyPath || !query) {
    console.error('Usage: tsx src/cli/link.ts --ontology <file.jsonld> --query "<question>" [--evidence "<hints>"]');
    return 2;
  }

  const raw = JSON.parse(readFileSync(ontologyPath, 'utf8')) as unknown;
  const ontology = OntologyJsonLdSchema.parse(raw);
  const index = buildOntologyIndex(ontology);

  const evidence = parseArg('--evidence');
  const hints = evidence ? parseEvidence(evidence, index).hints : undefined;
  const intent = linkQuestion(query, index, hints ? { hints } : {});
  console.log(JSON.stringify(intent, null, 2));

  // Resolve the join plan for the linked tables (the seam into the join resolver).
  if (intent.tables.length >= 2) {
    const graph = buildJoinGraph(index.joinEdges);
    const factTables = index.capabilities.filter((c) => c.kind === 'factTable').map((c) => c.scopeTable);
    const plan = resolveJoinPath(graph, intent.tables, { factTables });
    const onSql = (c: { on: Array<{ left: string; right: string }> }): string =>
      c.on.map((p) => `${p.left} = ${p.right}`).join(' AND ');
    console.log(`\nFROM ${plan.anchorTable}`);
    for (const c of plan.clauses) {
      const fan = c.multiplies ? ' [fan-out]' : '';
      console.log(`JOIN ${c.joinTable} ON ${onSql(c)}   -- ${c.cardinality}, ${c.provenance} ${c.confidence.toFixed(2)}${fan}`);
    }
    if (plan.unreachable.length > 0) console.log(`\n[!] unreachable: ${plan.unreachable.join(', ')}`);
  }

  return intent.tables.length > 0 ? 0 : 1;
}

process.exit(main());
