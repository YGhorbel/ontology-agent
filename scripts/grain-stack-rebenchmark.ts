/**
 * Grain-stack re-benchmark — frozen-IR A/B across the full grain bucket (the arc's measurement event).
 *
 *   EVAL_FORMULA1_DSN='postgresql://dev:dev@localhost:54321/formula1' pnpm tsx scripts/grain-stack-rebenchmark.ts
 *
 * MEASUREMENT-ONLY. Production code is untouched: this script composes the EXISTING exported stages into
 * two pipeline variants and toggles the four grain bricks on/off. Writes ONE results JSON under
 * eval/results/; the human-facing analysis lives in eval/results/grain-stack-rebenchmark.md.
 *
 * The four bricks under test (ADR-013→016):
 *   - Move-1 menu grain tag (ADR-013): the `[temporality]` annotation `renderPropLine` appends. Toggled
 *     OFF for baseline by feeding the planner a payload CLONE with `temporality` stripped (menu shows no
 *     tag). Compile still uses the artifact-true payload, so the older H2 de-cumulation stays CONSTANT
 *     across arms — H2 is NOT one of the four bricks and must not confound the measurement.
 *   - sibling-survival (ADR-014): `rescueFkSymmetricSiblings`. OFF for baseline (use the prune survivors).
 *   - snapshot enrichment (ADR-015): the 2 `as-of-event-snapshot` tags. OFF for baseline via the
 *     pre-ADR-015 artifact (eval/results/formula1-1781704520.pre-adr015.jsonld).
 *   - resolver (ADR-016): `resolveGrain`. OFF for baseline.
 *
 * Why two legs:
 *   - Baseline (stack OFF) vs Treatment (stack ON) full-64 EA: each arm RE-RUNS the planner, so its EA
 *     delta carries LLM run-to-run variance. Reported, but flagged noisy (NOT frozen-IR-clean).
 *   - Resolver-isolated frozen-IR delta: within the treatment arm, freeze the planner IR (pre-resolver),
 *     then compile+execute with resolveGrain OFF vs ON on the SAME IR. Zero LLM variance — THE clean
 *     number that isolates ADR-016.
 */
import 'dotenv/config';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildAnchorIndex } from '../src/query/anchor-index.js';
import type { AnchorIndex } from '../src/query/anchor-index.js';
import { buildGraph, loadCapabilities, tableOfClassIri } from '../src/query/graph-build.js';
import { makeRealLlm } from '../src/llm/client.js';
import { anchorQuestion } from '../src/query/anchor.js';
import { pruneTerminals } from '../src/query/prune.js';
import { rescueFkSymmetricSiblings } from '../src/query/sibling-survival.js';
import { groundSuperlatives } from '../src/query/superlative.js';
import { extractSubgraph } from '../src/query/subgraph.js';
import { deriveAnchoredColumns } from '../src/query/pipeline.js';
import { planQuery } from '../src/query/planner.js';
import { resolveGrain } from '../src/query/grain-resolve.js';
import { compile, CompileError } from '../src/query/compiler.js';
import type { OntologyGraph, SubgraphPayload, CapabilityRef } from '../src/query/graph-model.js';
import type { MetricQueryIR } from '../src/query/ir.js';
import { makeReadOnlyDbHandle } from '../eval/src/db.js';
import { executionMatch, birdStrictMatch } from '../eval/src/match.js';
import { goldHasTopLevelOrderBy } from '../eval/src/sql.js';

const TREATMENT_FIXTURE = resolve(process.cwd(), 'eval/fixtures/ontologies/formula1-1781704520.jsonld');
const BASELINE_FIXTURE = resolve(process.cwd(), 'eval/results/formula1-1781704520.pre-adr015.jsonld');
const GOLD_FILE = 'eval/gold/_f1-draft.jsonl';
const ROW_CAP = 20;
const PLANNER_MODEL = 'gpt-5-mini';

/** Known-suspect gold ids (mirrors scripts/benchmark.ts) — scored but excluded from the adjusted denom. */
const SUSPECT_IDS = new Set(['846', '847', '879', '892', '906', '931', '944'].map((n) => `f1-bird-${n}`));

/** The grain bucket assignment from the diagnostics (docs/diagnosis/grain-*). id → bucket. */
const GRAIN_BUCKET: Record<string, string> = {
  '950': '2a-asof', '994': '2a-agg', '892': '2a-max', '906': '2a-asof',
  '869': 'irreducible', '896': 'position', '902': 'position',
  '854': '2c-coltrim', '868': '2c-coltrim', '910': '2c-coltrim',
  '928': 'ex2b', '937': 'ex2b', '989': 'ex2b', '990': 'ex2b',
  '933': 'predicate',
};
const grainBucketOf = (id: string): string | undefined => GRAIN_BUCKET[id.replace('f1-bird-', '')];

const short = (iri: string): string => iri.replace(/^qsl:class\//, '').replace(/^qsl:property\//, '');

interface DraftGoldItem {
  id: string; dbName: string; question: string; goldSql: string;
  goldRows: unknown[][] | null; stratum: string;
  _draft: { birdDifficulty: string; flags: { flag: string; detail: string }[] };
}

function loadGold(): DraftGoldItem[] {
  return readFileSync(resolve(process.cwd(), GOLD_FILE), 'utf8')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l) as DraftGoldItem);
}

function gitSha(): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

interface Deps { index: AnchorIndex; graph: OntologyGraph; capabilities: CapabilityRef[]; }

function buildDeps(fixturePath: string): Deps {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
  return { index: buildAnchorIndex(raw), graph: buildGraph(raw, {}), capabilities: loadCapabilities(raw) };
}

/** Move-1 OFF: clone the payload with every column's grain tag stripped, so the planner menu shows none. */
function stripTemporality(payload: SubgraphPayload): SubgraphPayload {
  return {
    ...payload,
    classes: payload.classes.map((c) => ({
      iri: c.iri,
      properties: c.properties.map((p) => {
        const { temporality, temporalityEvidence, ...rest } = p;
        void temporality; void temporalityEvidence;
        return rest;
      }),
    })),
  };
}

/** Build the Stage-2 payload mirroring pipeline.ts:subgraphNode, with sibling-survival toggled by `siblings`. */
function buildPayload(
  question: string,
  deps: Deps,
  siblings: boolean,
): { payload: SubgraphPayload; disconnected: boolean } {
  const set = anchorQuestion(question, deps.index, {});
  const { terminals: pruned } = pruneTerminals(set);
  const anchoredColumns = deriveAnchoredColumns(set);
  let terminals = pruned;
  if (siblings) {
    terminals = rescueFkSymmetricSiblings({ candidates: set.terminals, kept: pruned, anchoredColumns, graph: deps.graph }).terminals;
  }
  const superlatives = groundSuperlatives(question, terminals, deps.graph);
  for (const d of superlatives) {
    const cols = anchoredColumns.get(d.classIri) ?? [];
    if (!cols.includes(d.column)) cols.push(d.column);
    anchoredColumns.set(d.classIri, cols);
  }
  const payload = extractSubgraph(deps.graph, terminals, [], deps.capabilities, { anchoredColumns });
  return { payload, disconnected: payload.disconnected ?? false };
}

interface ExecOut { rows: unknown[][]; error?: string; }
async function execSql(dsn: string, sql: string): Promise<ExecOut> {
  const handle = await makeReadOnlyDbHandle(dsn, 'formula1');
  try {
    const out = await handle.query(sql);
    return { rows: out.rows };
  } catch (e) {
    return { rows: [], error: String((e as Error)?.message ?? e) };
  } finally {
    await handle.close();
  }
}

/** Compile an IR against a payload; surface CompileError as a typed failure rather than throwing. */
function safeCompile(ir: MetricQueryIR, payload: SubgraphPayload): { sql?: string; error?: string } {
  try { return { sql: compile(ir, payload).sql }; }
  catch (e) { return { error: e instanceof CompileError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e) }; }
}

interface ArmResult {
  ok: boolean;
  failure?: string;
  sql: string | null;
  payloadTables: string[];
  payloadColumns: string[];
  rowCount: number | null;
  rows: unknown[][];
  match: boolean;
  birdStrict: boolean;
}

/** Run one full arm (baseline or treatment) for a question and execute against the live DB. */
async function runArm(
  question: string,
  deps: Deps,
  llm: ReturnType<typeof makeRealLlm>,
  dsn: string,
  goldRows: unknown[][],
  orderMatters: boolean,
  opts: { siblings: boolean; moveOneTag: boolean; resolver: boolean },
): Promise<{ arm: ArmResult; plannerIR?: MetricQueryIR; payload?: SubgraphPayload; resolutions: number; ambiguities: number; ambiguityCols: string[] }> {
  const empty = (failure: string): ArmResult => ({
    ok: false, failure, sql: null, payloadTables: [], payloadColumns: [], rowCount: null, rows: [], match: false, birdStrict: false,
  });

  const { payload, disconnected } = buildPayload(question, deps, opts.siblings);
  const payloadTables = payload.classes.map((c) => tableOfClassIri(c.iri));
  const payloadColumns = [...new Set(payload.classes.flatMap((c) => c.properties.map((p) => p.col)))];
  if (disconnected) return { arm: { ...empty('subgraph:disconnected'), payloadTables, payloadColumns }, resolutions: 0, ambiguities: 0, ambiguityCols: [] };

  const plannerPayload = opts.moveOneTag ? payload : stripTemporality(payload);
  // planQuery only catches LEASH failures; the inner structured-output `.withRetry` THROWS on parse
  // exhaustion (OUTPUT_PARSING_FAILURE). Catch it here so one bad LLM response becomes a recorded
  // per-question failure rather than crashing the whole 64-question run.
  let res: Awaited<ReturnType<typeof planQuery>>;
  try {
    res = await planQuery(question, plannerPayload, { llm });
  } catch (e) {
    return { arm: { ...empty(`planner:threw:${String((e as Error)?.message ?? e).slice(0, 80)}`), payloadTables, payloadColumns }, resolutions: 0, ambiguities: 0, ambiguityCols: [] };
  }
  if (!res.ok) return { arm: { ...empty('planner:repair-exhausted'), payloadTables, payloadColumns }, resolutions: 0, ambiguities: 0, ambiguityCols: [] };

  const plannerIR = res.ir;
  let finalIR = plannerIR;
  let resolutions = 0, ambiguities = 0;
  const ambiguityCols: string[] = [];
  if (opts.resolver) {
    const gr = resolveGrain(plannerIR, payload, deps.graph);
    finalIR = gr.ir;
    resolutions = gr.trace.resolutions.length;
    ambiguities = gr.trace.ambiguities.length;
    for (const a of gr.trace.ambiguities) ambiguityCols.push(a.column);
  }

  const compiled = safeCompile(finalIR, payload);
  if (!compiled.sql) return { arm: { ...empty(`compiler:${compiled.error}`), payloadTables, payloadColumns }, plannerIR, payload, resolutions, ambiguities, ambiguityCols };

  const exec = await execSql(dsn, compiled.sql);
  const match = !exec.error && executionMatch(goldRows, exec.rows, { orderMatters });
  const birdStrict = !exec.error && birdStrictMatch(goldRows, exec.rows);
  return {
    arm: {
      ok: true,
      ...(exec.error ? { failure: `execute:${exec.error}` } : {}),
      sql: compiled.sql, payloadTables, payloadColumns,
      rowCount: exec.error ? null : exec.rows.length, rows: exec.rows.slice(0, ROW_CAP),
      match, birdStrict,
    },
    plannerIR, payload, resolutions, ambiguities, ambiguityCols,
  };
}

/** Resolver-isolated frozen-IR leg: compile+execute the SAME treatment planner IR with resolveGrain off vs on. */
async function resolverFrozenLeg(
  plannerIR: MetricQueryIR,
  payload: SubgraphPayload,
  graph: OntologyGraph,
  dsn: string,
  goldRows: unknown[][],
  orderMatters: boolean,
): Promise<{ offSql: string | null; offMatch: boolean; onSql: string | null; onMatch: boolean; changed: boolean; resolutions: number; ambiguities: number; ambiguityCols: string[] }> {
  const off = safeCompile(plannerIR, payload);
  const gr = resolveGrain(plannerIR, payload, graph);
  const on = safeCompile(gr.ir, payload);
  const offRows = off.sql ? await execSql(dsn, off.sql) : { rows: [] as unknown[][], error: 'no-sql' };
  const onRows = on.sql ? await execSql(dsn, on.sql) : { rows: [] as unknown[][], error: 'no-sql' };
  return {
    offSql: off.sql ?? null,
    offMatch: !offRows.error && executionMatch(goldRows, offRows.rows, { orderMatters }),
    onSql: on.sql ?? null,
    onMatch: !onRows.error && executionMatch(goldRows, onRows.rows, { orderMatters }),
    changed: (off.sql ?? '') !== (on.sql ?? ''),
    resolutions: gr.trace.resolutions.length,
    ambiguities: gr.trace.ambiguities.length,
    ambiguityCols: gr.trace.ambiguities.map((a) => a.column),
  };
}

function goldTablesOf(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join)\s+("?)([a-z_][a-z0-9_]*)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.add(m[2]!.toLowerCase());
  return [...out];
}
function goldColumnsOf(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b[a-z_][a-z0-9_]*\.("?)([a-z_][a-z0-9_]*)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.add(m[2]!.toLowerCase());
  return [...out];
}

type BindingConstraint = 'resolved' | 'flagged' | 'retrieval-gated' | 'choice-gated' | 'n/a';

async function main(): Promise<void> {
  const dsn = process.env.EVAL_FORMULA1_DSN;
  if (!dsn) {
    console.error("FATAL: EVAL_FORMULA1_DSN unset. Re-run e.g.:\n  EVAL_FORMULA1_DSN='postgresql://dev:dev@localhost:54321/formula1' pnpm tsx scripts/grain-stack-rebenchmark.ts");
    process.exit(1);
  }
  const startedAt = new Date().toISOString();
  const unixTs = Math.floor(Date.parse(startedAt) / 1000);

  console.error('[rebench] building baseline + treatment deps …');
  const baselineDeps = buildDeps(BASELINE_FIXTURE);
  const treatmentDeps = buildDeps(TREATMENT_FIXTURE);
  const llm = makeRealLlm({ model: PLANNER_MODEL });
  let gold = loadGold();
  // Optional dry-run filter: REBENCH_IDS="950,994,869" restricts to those ids (bare numbers or full ids).
  const idFilter = process.env.REBENCH_IDS?.split(',').map((s) => s.trim()).filter(Boolean);
  if (idFilter?.length) {
    const want = new Set(idFilter.map((s) => (s.startsWith('f1-bird-') ? s : `f1-bird-${s}`)));
    gold = gold.filter((g) => want.has(g.id));
  }
  console.error(`[rebench] ${gold.length} questions; two LLM passes (baseline + treatment) + frozen-IR resolver leg.`);

  const records: any[] = [];
  for (let i = 0; i < gold.length; i++) {
    const item = gold[i]!;
    const grainBucket = grainBucketOf(item.id);
    console.error(`[rebench] (${i + 1}/${gold.length}) ${item.id}${grainBucket ? ` [grain:${grainBucket}]` : ''} — ${item.question.slice(0, 60)}`);
    const orderMatters = goldHasTopLevelOrderBy(item.goldSql);
    try {

    // Gold rows fresh (mirrors benchmark.ts — a fresh handle, isolated txn).
    const goldExec = await execSql(dsn, item.goldSql);
    const goldRows = goldExec.rows;

    // Treatment arm (stack ON).
    const t = await runArm(item.question, treatmentDeps, llm, dsn, goldRows, orderMatters,
      { siblings: true, moveOneTag: true, resolver: true });
    // Baseline arm (stack OFF).
    const b = await runArm(item.question, baselineDeps, llm, dsn, goldRows, orderMatters,
      { siblings: false, moveOneTag: false, resolver: false });

    // Resolver-isolated frozen-IR leg (only when treatment produced a planner IR + payload).
    let frozen: Awaited<ReturnType<typeof resolverFrozenLeg>> | null = null;
    if (t.plannerIR && t.payload) {
      frozen = await resolverFrozenLeg(t.plannerIR, t.payload, treatmentDeps.graph, dsn, goldRows, orderMatters);
    }

    // Binding-constraint classification (grain cases only).
    const goldTbls = goldTablesOf(item.goldSql);
    const goldCols = goldColumnsOf(item.goldSql);
    const tPayTbls = new Set(t.arm.payloadTables);
    const tPayCols = new Set(t.arm.payloadColumns);
    const tablesPresent = goldTbls.every((x) => tPayTbls.has(x));
    const colsPresent = goldCols.every((x) => tPayCols.has(x));
    let binding: BindingConstraint = 'n/a';
    if (grainBucket) {
      if (t.ambiguities > 0) binding = 'flagged';
      else if (!tablesPresent || !colsPresent) binding = 'retrieval-gated';
      else if (!t.arm.ok) binding = 'choice-gated'; // candidates present, but planner/compiler couldn't produce
      else if (t.arm.match) binding = 'resolved';
      else binding = 'choice-gated';
    }

    records.push({
      id: item.id, question: item.question, stratum: item.stratum,
      birdDifficulty: item._draft.birdDifficulty,
      isGrainCase: Boolean(grainBucket), grainBucket: grainBucket ?? null,
      isSuspect: SUSPECT_IDS.has(item.id),
      goldErrored: Boolean(goldExec.error), goldRowCount: goldExec.error ? null : goldRows.length,
      goldTables: goldTbls, goldColumns: goldCols,
      tablesPresentTreatment: tablesPresent, colsPresentTreatment: colsPresent,
      treatment: { ...t.arm, resolutions: t.resolutions, ambiguities: t.ambiguities, ambiguityCols: t.ambiguityCols },
      baseline: b.arm,
      resolverFrozen: frozen,
      bindingConstraint: binding,
    });
    } catch (e) {
      console.error(`[rebench]   ! ${item.id} threw, recorded as crashed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      records.push({
        id: item.id, question: item.question, stratum: item.stratum, birdDifficulty: item._draft.birdDifficulty,
        isGrainCase: Boolean(grainBucket), grainBucket: grainBucket ?? null, isSuspect: SUSPECT_IDS.has(item.id),
        goldErrored: true, goldRowCount: null, goldTables: goldTablesOf(item.goldSql), goldColumns: goldColumnsOf(item.goldSql),
        tablesPresentTreatment: false, colsPresentTreatment: false,
        treatment: { ok: false, failure: `crashed:${String((e as Error)?.message ?? e).slice(0, 80)}`, sql: null, payloadTables: [], payloadColumns: [], rowCount: null, rows: [], match: false, birdStrict: false, resolutions: 0, ambiguities: 0, ambiguityCols: [] },
        baseline: { ok: false, failure: 'crashed', sql: null, payloadTables: [], payloadColumns: [], rowCount: null, rows: [], match: false, birdStrict: false },
        resolverFrozen: null, bindingConstraint: 'n/a',
      });
    }
  }

  // ── Aggregate ────────────────────────────────────────────────────────────────
  const ea = (rs: any[], pick: (r: any) => boolean) => {
    const n = rs.length, m = rs.filter(pick).length;
    return { n, m, acc: n === 0 ? 0 : Number((m / n).toFixed(4)) };
  };
  const grain = records.filter((r) => r.isGrainCase);
  const grainNonSuspect = grain.filter((r) => !r.isSuspect);
  const nonSuspect = records.filter((r) => !r.isSuspect);

  const bindingCounts: Record<string, number> = {};
  for (const r of grain) bindingCounts[r.bindingConstraint] = (bindingCounts[r.bindingConstraint] ?? 0) + 1;

  // Frozen-IR resolver delta over the whole 64 (clean: same planner IR, resolver off vs on).
  const frozenAll = records.filter((r) => r.resolverFrozen);
  const frozenOff = ea(frozenAll, (r) => r.resolverFrozen.offMatch);
  const frozenOn = ea(frozenAll, (r) => r.resolverFrozen.onMatch);
  const frozenChanged = frozenAll.filter((r) => r.resolverFrozen.changed).map((r) => r.id);
  const flagged = grain.filter((r) => r.treatment.ambiguities > 0).map((r) => ({ id: r.id, cols: r.treatment.ambiguityCols }));

  const aggregate = {
    whole64: {
      baselineEA: ea(records, (r) => r.baseline.match),
      treatmentEA: ea(records, (r) => r.treatment.match),
      baselineEA_adj: ea(nonSuspect, (r) => r.baseline.match),
      treatmentEA_adj: ea(nonSuspect, (r) => r.treatment.match),
    },
    grainSubset: {
      baselineEA: ea(grain, (r) => r.baseline.match),
      treatmentEA: ea(grain, (r) => r.treatment.match),
      baselineEA_noSuspect: ea(grainNonSuspect, (r) => r.baseline.match),
      treatmentEA_noSuspect: ea(grainNonSuspect, (r) => r.treatment.match),
    },
    resolverFrozenIR: { off: frozenOff, on: frozenOn, changedIds: frozenChanged },
    flaggedIrreducible: flagged,
    bindingConstraintCounts: bindingCounts,
    regressionCheck: records
      .filter((r) => !r.isGrainCase && r.baseline.match !== r.treatment.match)
      .map((r) => ({ id: r.id, baseline: r.baseline.match, treatment: r.treatment.match })),
  };

  const runHeader = {
    gitSha: gitSha(), modelString: PLANNER_MODEL, set: 'f1-draft', system: 'nl2sql-grain-rebench',
    startedAt, goldFile: GOLD_FILE,
    baselineFixture: 'formula1-1781704520.pre-adr015.jsonld', treatmentFixture: 'formula1-1781704520.jsonld',
  };

  mkdirSync(resolve(process.cwd(), 'eval/results'), { recursive: true });
  const outPath = resolve(process.cwd(), `eval/results/grain-rebench-${unixTs}.json`);
  writeFileSync(outPath, `${JSON.stringify({ runHeader, aggregate, records }, null, 2)}\n`, { flag: 'wx' });

  console.error('\n══════════════════════════════════════════════════════════════');
  console.error(`whole-64  baseline EA : ${aggregate.whole64.baselineEA.m}/${aggregate.whole64.baselineEA.n} = ${(aggregate.whole64.baselineEA.acc * 100).toFixed(1)}%`);
  console.error(`whole-64  treatment EA: ${aggregate.whole64.treatmentEA.m}/${aggregate.whole64.treatmentEA.n} = ${(aggregate.whole64.treatmentEA.acc * 100).toFixed(1)}%`);
  console.error(`grain     baseline EA : ${aggregate.grainSubset.baselineEA.m}/${aggregate.grainSubset.baselineEA.n}`);
  console.error(`grain     treatment EA: ${aggregate.grainSubset.treatmentEA.m}/${aggregate.grainSubset.treatmentEA.n}`);
  console.error(`resolver frozen-IR    : off ${frozenOff.m}/${frozenOff.n}  →  on ${frozenOn.m}/${frozenOn.n}  (changed: ${frozenChanged.join(', ') || 'none'})`);
  console.error(`flagged-irreducible   : ${flagged.map((f) => f.id).join(', ') || 'none'}`);
  console.error(`binding constraints   : ${JSON.stringify(bindingCounts)}`);
  console.error(`regressions (non-grain): ${JSON.stringify(aggregate.regressionCheck)}`);
  console.error(`\nwrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
