/**
 * CLI entry point — resolve a JOIN path from a generated ontology (no LLM, no DB).
 *
 *   tsx src/cli/joinpath.ts --ontology out/ontology-formula1-XXXX.jsonld --tables drivers,circuits
 *   pnpm run joinpath --ontology <file.jsonld> --tables a,b,c
 *
 * Loads the ontology's join graph and prints the FROM/JOIN skeleton connecting the
 * requested tables, weighted so declared FKs are preferred over discovered ones.
 */
import { readFileSync } from 'node:fs';
import { buildOntologyIndex, loadFullGraph } from '../query/ontology-index.js';
import { buildJoinGraph, resolveJoinPath, resolveAllPaths } from '../query/join-graph.js';

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
  const tablesArg = parseArg('--tables');
  if (!ontologyPath || !tablesArg) {
    console.error('Usage: tsx src/cli/joinpath.ts --ontology <file.jsonld> --tables a,b,c');
    return 2;
  }
  const tables = tablesArg.split(',').map((t) => t.trim()).filter(Boolean);
  const minConfArg = parseArg('--min-confidence');
  const minConfidence = minConfArg !== undefined ? Number(minConfArg) : undefined;
  const pathsArg = parseArg('--paths');
  const k = pathsArg !== undefined ? Number(pathsArg) : undefined;

  const raw = JSON.parse(readFileSync(ontologyPath, 'utf8')) as unknown;
  const ontology = loadFullGraph(raw);
  const index = buildOntologyIndex(ontology);
  const graph = buildJoinGraph(index.joinEdges);

  const factTables = index.capabilities.filter((c) => c.kind === 'factTable').map((c) => c.scopeTable);
  const conf = minConfidence !== undefined ? { minConfidence } : {};

  // --paths K: emit the K-best scored candidates as JSON (the LLM-facing payload).
  if (k !== undefined) {
    if (tables.length !== 2) {
      console.error('--paths requires exactly 2 tables (K-best enumeration is pairwise).');
      return 2;
    }
    const candidates = resolveAllPaths(graph, tables, { factTables, k, ...conf });
    console.log(JSON.stringify({ requested: tables, candidates }, null, 2));
    return candidates.length > 0 ? 0 : 1;
  }

  const onSql = (c: { on: Array<{ left: string; right: string }> }): string =>
    c.on.map((p) => `${p.left} = ${p.right}`).join(' AND ');

  const plan = resolveJoinPath(graph, tables, { factTables, ...conf });

  console.log(`\nRequested: ${tables.join(', ')}`);
  console.log(`Join graph: ${index.classes.size} tables, ${index.joinEdges.length} edges\n`);
  if (plan.lowConfidence) {
    console.log('[⚠] best-effort path: relies on a low-confidence discovered edge (see conf below)\n');
  }
  if (plan.fanOut) {
    console.log('[fan-out] a hop multiplies rows — aggregates over this path may need DISTINCT / a subquery\n');
  }
  console.log(`FROM ${plan.anchorTable}`);
  for (const c of plan.clauses) {
    const tag = `${c.provenance} ${c.confidence.toFixed(2)}`;
    const fan = c.multiplies ? ' [fan-out]' : '';
    console.log(`JOIN ${c.joinTable} ON ${onSql(c)}   -- ${c.cardinality}, ${tag}${fan}`);
  }
  if (plan.unreachable.length > 0) {
    console.log(`\n[!] unreachable (no join path to anchor): ${plan.unreachable.join(', ')}`);
    return 1;
  }
  return 0;
}

process.exit(main());
