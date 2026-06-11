#!/usr/bin/env -S npx tsx
/**
 * qwery — interactive query terminal.
 *
 *   qwery "postgresql://user:pass@host:5432/ecommerce"
 *   pnpm qwery "postgresql://...:5432/formula1"
 *   npx tsx src/cli/qwery.ts "<dsn>" [--ontology <file.jsonld>] [--datasource <id>]
 *
 * Opens a REPL over a generated ontology: type a natural-language question and see
 * the schema-linking result (the typed QueryIntent — tables, measures, filters,
 * group dimensions, ambiguities, unresolved) and the join plan the resolver derives
 * for it. No LLM, no SQL execution (yet) — this is the deterministic query front end
 * we built (Sprint 0 join resolver + Sprint 2 schema linker).
 *
 * The DSN's database name selects which generated ontology to load from OUT_DIR
 * (run `pnpm generate --dsn <dsn>` first if none exists). The DB is soft-pinged so
 * a bad connection string is reported, but a live DB is not required to link/plan.
 */
import 'dotenv/config'; // load .env so --llm can read AZURE_OPENAI_*/OPENAI_API_KEY
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as readline from 'node:readline';
import { Client } from 'pg';
import { OntologyJsonLdSchema } from '../types/ontology.js';
import { buildOntologyIndex, type OntologyIndex } from '../query/ontology-index.js';
import { buildJoinGraph, resolveJoinPath, resolveAllPaths } from '../query/join-graph.js';
import { linkQuestion } from '../query/schema-linker.js';
import { parseEvidence } from '../query/evidence.js';
import { intentToSql, onSql } from '../query/intent-to-sql.js';
import { generateSqlWithLlm } from '../query/llm-sql.js';
import { resolveIntent, pickHint, type Clarification } from '../query/llm-intent.js';
import { makeRealLlm } from '../llm/client.js';
import type { StructuredLlm } from '../llm/structured-llm.js';
import type { LinkHints, QueryIntent } from '../types/query-intent.js';

function parseFlag(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a?.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

/** First positional argument that isn't a flag or a flag's value. */
function positional(): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a.startsWith('-')) {
      if (!a.includes('=')) i += 1; // skip this flag's value
      continue;
    }
    return a;
  }
  return undefined;
}

/** Derive a datasource id from a connection string's database name. */
function datasourceIdFromDsn(dsn: string): string | undefined {
  try {
    const db = new URL(dsn).pathname.replace(/^\//, '').trim();
    return db.length > 0 ? db : undefined;
  } catch {
    return undefined;
  }
}

/** Newest `ontology-<id>-*.jsonld` in OUT_DIR, or undefined if none. */
function latestOntologyFor(datasourceId: string): string | undefined {
  const outDir = resolve(process.env.OUT_DIR ?? 'out');
  let files: string[];
  try {
    files = readdirSync(outDir);
  } catch {
    return undefined;
  }
  const prefix = `ontology-${datasourceId}-`;
  const matches = files.filter((f) => f.startsWith(prefix) && f.endsWith('.jsonld')).sort();
  const newest = matches[matches.length - 1];
  return newest ? resolve(outDir, newest) : undefined;
}

async function pingDb(dsn: string): Promise<string> {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return 'connected';
  } catch (err) {
    return `unreachable (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`;
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

function printIntent(intent: QueryIntent, index: OntologyIndex, opts: { source?: 'deterministic' | 'llm'; warnings?: string[] } = {}): void {
  const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
  const measures = intent.measures.map((m) => `${m.table}.${m.column}${m.capability ? ` (${m.capability})` : ''}`);
  const filters = intent.filters.map((f) => `${f.table}.${f.column} ${f.op} ${f.value}${f.matchedSample ? ' [value-dict]' : ''}`);
  const dims = intent.groupDims.map((g) => `${g.table}.${g.column}`);

  const projection = intent.projection.map((p) => `${p.table}.${p.column}`);
  const order = intent.orderBy.map((o) => `${o.table}.${o.column} ${o.dir}`);

  const tag = opts.source ? dim(` [${opts.source}]`) : '';
  console.log(dim('\n── intent ──────────────────────────────────') + tag);
  for (const w of opts.warnings ?? []) console.log(dim(`  ! ${w}`));
  console.log(`  tables   : ${intent.tables.join(', ') || dim('(none)')}`);
  console.log(`  select   : ${projection.join(', ') || dim('-')}`);
  console.log(`  measures : ${measures.join(', ') || dim('-')}`);
  console.log(`  group by : ${dims.join(', ') || dim('-')}`);
  console.log(`  filters  : ${filters.join(', ') || dim('-')}`);
  console.log(`  order by : ${order.join(', ') || dim('-')}`);
  console.log(`  limit    : ${intent.limit != null ? String(intent.limit) : dim('-')}`);
  if (intent.ambiguities.length > 0) {
    for (const a of intent.ambiguities) {
      const opts = a.candidates.map((c) => `${c.ref.table}${c.ref.column ? `.${c.ref.column}` : ''}`).join(' | ');
      console.log(`  \x1b[33m⚠ ambiguous\x1b[0m "${a.span}" → ${opts}`);
    }
  }
  if (intent.unresolved.length > 0) {
    console.log(`  \x1b[33m⚠ unresolved\x1b[0m : ${intent.unresolved.join(', ')}`);
  }

  // Join plan + SQL for the linked tables (the seam into the resolver, then synthesis).
  if (intent.tables.length >= 1) {
    const graph = buildJoinGraph(index.joinEdges);
    const factTables = index.capabilities.filter((c) => c.kind === 'factTable').map((c) => c.scopeTable);
    const plan = resolveJoinPath(graph, intent.tables, { factTables });

    console.log(dim('── join plan ───────────────────────────────'));
    if (intent.tables.length === 1) {
      console.log(`  FROM ${intent.tables[0]}   ${dim('(single table, no join)')}`);
    } else {
      if (plan.lowConfidence) console.log('  \x1b[33m[best-effort: low-confidence edge]\x1b[0m');
      console.log(`  FROM ${plan.anchorTable}`);
      for (const c of plan.clauses) {
        const fan = c.multiplies ? ' \x1b[33m[fan-out]\x1b[0m' : '';
        console.log(`  JOIN ${c.joinTable} ON ${onSql(c)}   ${dim(`-- ${c.cardinality}, ${c.provenance} ${c.confidence.toFixed(2)}`)}${fan}`);
      }
      if (plan.unreachable.length > 0) console.log(`  \x1b[31m[!] unreachable: ${plan.unreachable.join(', ')}\x1b[0m`);
      if (intent.tables.length === 2) {
        const cands = resolveAllPaths(graph, intent.tables, { factTables, k: 5 });
        if (cands.length > 1) console.log(dim(`  (${cands.length} alternative join paths — '\\paths' to list)`));
      }
    }

    const { sql, warnings } = intentToSql(intent, plan, index);
    console.log(dim('── sql ─────────────────────────────────────'));
    console.log(sql.split('\n').map((l) => `  ${l}`).join('\n'));
    for (const w of warnings) console.log(dim(`  -- note: ${w}`));
  }
  console.log('');
}

function printPaths(intent: QueryIntent, index: OntologyIndex): void {
  if (intent.tables.length !== 2) {
    console.log('  (alternative paths are listed for exactly 2 linked tables)\n');
    return;
  }
  const graph = buildJoinGraph(index.joinEdges);
  const factTables = index.capabilities.filter((c) => c.kind === 'factTable').map((c) => c.scopeTable);
  const cands = resolveAllPaths(graph, intent.tables, { factTables, k: 5 });
  console.log(`\n  ${cands.length} candidate join paths (best first):`);
  cands.forEach((c, i) => {
    const hops = c.path.clauses.map((cl) => cl.joinTable).join(' → ');
    console.log(`   ${i + 1}. score ${c.score.toFixed(3)}  hops ${c.hops}  ${c.fanOut ? '[fan-out] ' : ''}${c.path.anchorTable} → ${hops} ${`\x1b[2m[${c.provenanceMix.join(',')}]\x1b[0m`}`);
  });
  console.log('');
}

function printClarification(c: Clarification): void {
  const opts = c.options.map((o, i) => `${i + 1}) ${o.table}${o.column ? `.${o.column}` : ''}`).join('   ');
  console.log(`\x1b[33m  ⚠ clarify\x1b[0m ${c.question}`);
  console.log(`    ${opts}`);
  console.log('    reply: \\pick <n>\n');
}

async function printLlmSql(question: string, index: OntologyIndex, llm: StructuredLlm): Promise<void> {
  const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
  try {
    const out = await generateSqlWithLlm(question, index, llm);
    console.log(dim('── sql (llm) ───────────────────────────────'));
    console.log(dim(`  grounding: ${out.stats.sliceTokens} tok (-${out.stats.reductionPct}% vs full ${out.stats.fullTokens})`));
    console.log(out.sql.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log(dim(`  -- ${out.rationale}`));
    console.log('');
  } catch (err) {
    console.log(`  \x1b[31m[llm] ${err instanceof Error ? err.message.split('\n')[0] : String(err)}\x1b[0m\n`);
  }
}

const HELP = `
  Type a natural-language question, e.g.:
    total points for British constructors
    revenue for active customers
    order count by currency
  Commands:
    \\tables           list the ontology's tables
    \\paths            show alternative join paths for the last question
    \\evidence <text>  apply BIRD-style hints ("X refers to Y; … MAX(col)…"); \\evidence alone clears
    \\pick <n>         answer a clarification (disambiguate the flagged span)
    \\llm [question]   grounded LLM SQL fallback (needs --llm at startup); no arg re-runs the last question
    \\help             this help
    \\q, exit          quit
`;

async function main(): Promise<void> {
  const dsn = positional() ?? parseFlag('--dsn');
  if (!dsn) {
    console.error('Usage: qwery "<postgres-connection-string>" [--ontology <file.jsonld>] [--datasource <id>]');
    process.exit(2);
  }

  const datasourceId = parseFlag('--datasource') ?? datasourceIdFromDsn(dsn);
  if (!datasourceId) {
    console.error('Could not derive a datasource id from the connection string; pass --datasource <id>.');
    process.exit(2);
  }

  const ontologyPath = parseFlag('--ontology') ?? latestOntologyFor(datasourceId);
  if (!ontologyPath) {
    console.error(`No generated ontology found for "${datasourceId}" in ${resolve(process.env.OUT_DIR ?? 'out')}.`);
    console.error(`Generate one first:\n  pnpm generate --dsn "${dsn}"`);
    process.exit(1);
  }

  let index: OntologyIndex;
  try {
    const ontology = OntologyJsonLdSchema.parse(JSON.parse(readFileSync(ontologyPath, 'utf8')));
    index = buildOntologyIndex(ontology);
  } catch (err) {
    console.error(`Failed to load ontology ${ontologyPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Grounded LLM tier (opt-in): only built when --llm is passed, so the default
  // experience needs no API key. Construction is lazy-safe; failures surface on use.
  const llmEnabled = process.argv.slice(2).includes('--llm');
  let llm: StructuredLlm | null = null;
  if (llmEnabled) {
    try {
      llm = makeRealLlm();
    } catch (err) {
      console.error(`  [llm] could not initialise: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --verbose narrates the retrieve → llm → validate steps of intent resolution.
  const verbose = process.argv.slice(2).includes('--verbose');
  const log = verbose ? (m: string): void => console.log(`\x1b[2m  [intent] ${m}\x1b[0m`) : undefined;

  const status = await pingDb(dsn);
  console.log(`\nqwery — datasource "${datasourceId}"`);
  console.log(`  db       : ${status}`);
  console.log(`  ontology : ${ontologyPath.split('/').pop()} (${index.classes.size} tables, ${index.joinEdges.length} join edges)`);
  console.log(`  llm      : ${llm ? 'enabled (intent tier auto on weak intent; \\llm = SQL fallback)' : 'disabled (start with --llm to enable)'}`);
  console.log(HELP);

  let last: QueryIntent | null = null;
  let lastQuestion = '';
  let hints: LinkHints | undefined;
  // A pending clarification (LLM flagged an ambiguous span) awaiting a `\pick <n>`.
  let pending: { question: string; clarification: Clarification } | null = null;
  // Surface active evidence in the prompt so persistent hints can't silently skew a
  // later question (the phantom-ORDER-BY foot-gun).
  const promptStr = (): string => (hints ? 'qwery(ev)> ' : 'qwery> ');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: promptStr() });

  // Resolve the intent (deterministic linker, falling through to the grounded LLM tier
  // when weak), render its SQL, and surface any clarification the LLM raised.
  const ask = async (question: string): Promise<void> => {
    const r = await resolveIntent(question, index, { ...(llm ? { llm } : {}), ...(hints ? { hints } : {}), ...(log ? { log } : {}) });
    last = r.intent;
    lastQuestion = question;
    printIntent(last, index, { source: r.source, ...(r.warnings ? { warnings: r.warnings } : {}) });
    if (r.error) console.log(`  \x1b[31m[llm] ${r.error}\x1b[0m`);
    pending = r.clarification ? { question, clarification: r.clarification } : null;
    if (r.clarification) printClarification(r.clarification);
    hints = undefined; // evidence is one-shot — never silently persist into the next question
  };

  // Resolve a pending clarification: bind the chosen element as an alias hint and re-ask.
  const doPick = async (n: number): Promise<void> => {
    if (!pending) { console.log('  (nothing to disambiguate)\n'); return; }
    const opts = pending.clarification.options;
    if (!Number.isInteger(n) || n < 1 || n > opts.length) { console.log(`  (pick 1..${opts.length})\n`); return; }
    const ref = opts[n - 1]!;
    const q = pending.question;
    hints = pickHint(pending.clarification.span, ref);
    pending = null;
    await ask(q);
  };

  rl.prompt();
  rl.on('line', (raw) => {
    void (async () => {
      const line = raw.trim();
      if (line === '') { rl.prompt(); return; }
      if (line === '\\q' || line === 'exit' || line === 'quit' || line === '\\quit') { rl.close(); return; }

      // Inline evidence: "<question> \evidence <hints>" — apply the hints to this question.
      const inlineEv = line.indexOf('\\evidence ');
      if (inlineEv > 0) {
        const qPart = line.slice(0, inlineEv).trim();
        hints = parseEvidence(line.slice(inlineEv + '\\evidence '.length), index).hints;
        if (qPart) await ask(qPart);
        rl.setPrompt(promptStr());
        rl.prompt();
        return;
      }

      if (pending && /^\d+$/.test(line)) {
        await doPick(Number(line));
      } else if (line === '\\pick' || line.startsWith('\\pick ')) {
        await doPick(Number(line.slice('\\pick'.length).trim()));
      } else if (line === '\\help' || line === 'help') {
        console.log(HELP);
      } else if (line === '\\tables') {
        console.log(`  ${[...index.classes.keys()].sort().join(', ')}\n`);
      } else if (line === '\\paths') {
        if (last) printPaths(last, index);
        else console.log('  (ask a question first)\n');
      } else if (line === '\\llm' || line.startsWith('\\llm ')) {
        const q = line === '\\llm' ? lastQuestion : line.slice('\\llm '.length).trim();
        if (!llm) console.log('  (start qwery with --llm, and set OPENAI_API_KEY / Azure env)\n');
        else if (!q) console.log('  (ask a question first)\n');
        else {
          if (line !== '\\llm') { last = linkQuestion(q, index, hints ? { hints } : {}); lastQuestion = q; printIntent(last, index); }
          await printLlmSql(q, index, llm);
        }
      } else if (line === '\\evidence') {
        hints = undefined;
        console.log('  evidence cleared\n');
      } else if (line.startsWith('\\evidence ')) {
        const parsed = parseEvidence(line.slice('\\evidence '.length), index);
        hints = parsed.hints;
        const n = hints.aliases.length + hints.values.length + hints.orderBy.length + (hints.limit != null ? 1 : 0);
        console.log(`  evidence applied: ${n} hint(s)${parsed.dropped.length ? `, ${parsed.dropped.length} clause(s) unparsed` : ''}\n`);
      } else {
        await ask(line);
      }
      rl.setPrompt(promptStr());
      rl.prompt();
    })();
  });
  rl.on('close', () => {
    console.log('bye');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
