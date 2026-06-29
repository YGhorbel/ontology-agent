/**
 * First real execution-accuracy benchmark of the full NL2SQL pipeline against the
 * DRAFT gold (`eval/gold/_f1-draft.jsonl`).
 *
 *   EVAL_FORMULA1_DSN='postgresql://dev:dev@localhost:54321/formula1' pnpm tsx scripts/benchmark.ts
 *
 * For every gold question it runs the pipeline (anchor→prune→superlative→subgraph→
 * planner→compile→execute) to produce SQL+rows, executes the GOLD SQL against the same
 * live DB, and execution-matches the two result sets with the harness matcher
 * (eval/src/match.ts). Because the gold is a DRAFT, a mismatch may mean the SYSTEM is
 * wrong OR the GOLD is wrong — so every per-question record preserves predicted SQL+rows,
 * gold SQL+rows (capped), the mismatch shape, and a pipeline trace summary to triage that.
 *
 * Read-only over the system. The ONLY writes are the timestamped results JSON under
 * eval/results/. Reuses the harness (match/db/sql/types) and `runPipeline` — no new
 * harness code, no pipeline changes, no gold edits.
 */
import 'dotenv/config'; // load .env so the planner LLM can read OPENAI_API_KEY / AZURE_OPENAI_*
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildAnchorIndex } from '../src/query/anchor-index.js';
import { buildGraph, loadCapabilities } from '../src/query/graph-build.js';
import { makeRealLlm } from '../src/llm/client.js';
import { runPipeline, type PipelineDeps, type PipelineResult } from '../src/query/pipeline.js';
import { makeReadOnlyDbHandle } from '../eval/src/db.js';
import { executionMatch, birdStrictMatch } from '../eval/src/match.js';
import { goldHasTopLevelOrderBy } from '../eval/src/sql.js';
import type { RunHeader } from '../eval/src/types.js';

const FIXTURE = resolve(process.cwd(), 'eval/fixtures/ontologies/formula1-1781704520.jsonld');
const GOLD_FILE = 'eval/gold/_f1-draft.jsonl';
const PLANNER_MODEL = 'gpt-5-mini'; // hardcoded in src/query/planner.ts
const ROW_CAP = 20;

/** The known-suspect ids from prior verification (see task brief). Stored as `f1-bird-<n>`. */
const SUSPECT_IDS = new Set(['846', '847', '879', '892', '906', '931', '944'].map((n) => `f1-bird-${n}`));

const short = (iri: string): string => iri.replace(/^qsl:class\//, '').replace(/^qsl:property\//, '');

// ── Draft-gold record shape (typed inline in eval/scripts/_draft_f1_gold.ts) ─────
interface DraftFlag {
  flag: string;
  detail: string;
}
interface DraftGoldItem {
  id: string;
  dbName: string;
  question: string;
  goldSql: string;
  goldRows: unknown[][] | null;
  stratum: string;
  stratumConfidence?: string;
  _draft: {
    birdEvidence?: string;
    birdDifficulty: string;
    rowCount: number | null;
    flags: DraftFlag[];
  };
}

type MismatchShape =
  | `pipeline-failure:${string}`
  | 'row-count-diff'
  | 'value-diff'
  | 'empty-predicted'
  | 'empty-gold';

interface TraceSummary {
  terminalsKept: string[];
  terminalsDroppedCount: number;
  payloadTables: string[];
  joinCount: number;
  subgraphDisconnected: boolean;
  superlativeFired: boolean;
  superlativeDirectives: { token: string; column: string; dir: string }[];
  valueGroundingFired: boolean;
  /** Best-effort: the cumulative-snapshot (temporality) rewrite leaves a marker in the IR. */
  temporalityFired: boolean;
  plannerOutcome: string | null;
}

interface PerQuestion {
  id: string;
  question: string;
  stratum: string;
  birdDifficulty: string;
  flags: DraftFlag[];
  predictedSql: string | null;
  failureStage?: string;
  failureReason?: string;
  predictedRowCount: number | null;
  predictedRows: unknown[][];
  goldSql: string;
  goldRowCount: number | null;
  goldRows: unknown[][];
  goldErrored: boolean;
  goldError?: string;
  orderMatters: boolean;
  match: boolean;
  birdStrictMatch: boolean;
  mismatchShape?: MismatchShape;
  isSuspectGold: boolean;
  traceSummary: TraceSummary | null;
}

function loadGold(): DraftGoldItem[] {
  const raw = readFileSync(resolve(process.cwd(), GOLD_FILE), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as DraftGoldItem);
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function summarizeTrace(res: PipelineResult): TraceSummary {
  const t = res.traces;
  const kept = t.prune?.kept ?? res.anchorSet?.terminals ?? [];
  const sup = t.superlative ?? [];
  const payload = res.ok ? res.payload : res.payload;
  const irBlob = JSON.stringify(res.ok ? res.ir : (res.ir ?? {})).toLowerCase();
  return {
    terminalsKept: kept.map(short),
    terminalsDroppedCount: t.prune?.dropped.length ?? 0,
    payloadTables: (payload?.classes ?? []).map((c) => short(c.iri)),
    joinCount: payload?.joins.length ?? 0,
    subgraphDisconnected: t.subgraph?.disconnected ?? false,
    superlativeFired: sup.length > 0,
    superlativeDirectives: sup.map((d) => ({ token: d.token, column: d.column, dir: d.dir })),
    // value-grounding = a value anchor classed a terminal (a named data value was matched).
    valueGroundingFired: (res.anchorSet?.valueAnchors?.length ?? 0) > 0,
    temporalityFired: irBlob.includes('cumulative') || irBlob.includes('snapshot') || irBlob.includes('temporal'),
    plannerOutcome: t.planner?.outcome ?? null,
  };
}

function classifyMismatch(
  res: PipelineResult,
  predictedRows: unknown[][],
  goldRows: unknown[][],
): MismatchShape | undefined {
  if (!res.ok) return `pipeline-failure:${res.failure.stage}`;
  const predEmpty = predictedRows.length === 0;
  const goldEmpty = goldRows.length === 0;
  if (predEmpty && !goldEmpty) return 'empty-predicted';
  if (goldEmpty && !predEmpty) return 'empty-gold';
  if (predictedRows.length !== goldRows.length) return 'row-count-diff';
  return 'value-diff';
}

async function main(): Promise<void> {
  const dsn = process.env.EVAL_FORMULA1_DSN;
  if (!dsn) {
    console.error(
      'FATAL: EVAL_FORMULA1_DSN is not set. This is a LIVE execution-match benchmark and ' +
        'refuses to fall back to a structural-only number (it would be misleading and uncitable).\n' +
        "  Re-run with e.g.:\n  EVAL_FORMULA1_DSN='postgresql://dev:dev@localhost:54321/formula1' pnpm tsx scripts/benchmark.ts",
    );
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const unixTs = Math.floor(Date.parse(startedAt) / 1000);
  const dbUrl = new URL(dsn);

  console.error(`[benchmark] loading gold from ${GOLD_FILE} …`);
  const gold = loadGold();
  console.error(`[benchmark] ${gold.length} questions; building pipeline deps (anchor/graph/capabilities/llm) …`);

  const rawOnto = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  const deps: PipelineDeps = {
    index: buildAnchorIndex(rawOnto),
    graph: buildGraph(rawOnto, {}),
    capabilities: loadCapabilities(rawOnto),
    llm: makeRealLlm(),
  };

  const perQuestion: PerQuestion[] = [];
  let promptVersion = 'none';

  for (let i = 0; i < gold.length; i += 1) {
    const item = gold[i];
    console.error(`[benchmark] (${i + 1}/${gold.length}) ${item.id} — ${item.question.slice(0, 70)}`);

    // Fresh read-only handle PER question: db.ts runs one lifetime `BEGIN TRANSACTION
    // READ ONLY`, so a single failing query would poison every later query. Isolate it.
    let handle: Awaited<ReturnType<typeof makeReadOnlyDbHandle>> | undefined;
    const orderMatters = goldHasTopLevelOrderBy(item.goldSql);
    let rec: PerQuestion;

    try {
      handle = await makeReadOnlyDbHandle(dsn, 'formula1');
      deps.db = handle;

      // 1) Predicted: run the pipeline (executes its own SQL because deps.db is set).
      let res: PipelineResult;
      try {
        res = await runPipeline(item.question, deps);
      } catch (e) {
        // A throw here is unexpected (the pipeline routes failures gracefully) — record it,
        // never abort the whole run.
        res = {
          ok: false,
          failure: { stage: 'execute', reason: 'pipeline-threw', detail: String((e as Error)?.message ?? e) },
          traces: {},
        };
      }

      const predictedSql = res.ok ? res.sql : null;
      const predictedRows = res.ok ? (res.rows ?? []) : [];
      if (res.ok && res.traces.planner?.promptVersion) promptVersion = res.traces.planner.promptVersion;

      // 2) Gold: execute goldSql fresh against the same live DB (separate handle would also
      //    work, but a failing predicted query already aborted THIS txn — so use a 2nd handle).
      let goldRows: unknown[][] = [];
      let goldErrored = false;
      let goldError: string | undefined;
      {
        // predicted execution may have aborted the read-only txn; open a clean handle for gold.
        const goldHandle = await makeReadOnlyDbHandle(dsn, 'formula1');
        try {
          const out = await goldHandle.query(item.goldSql);
          goldRows = out.rows;
        } catch (e) {
          goldErrored = true;
          goldError = String((e as Error)?.message ?? e);
        } finally {
          await goldHandle.close();
        }
      }

      // 3) Match (headline = harness executionMatch; also record pure-set birdStrictMatch).
      const match = !goldErrored && res.ok && executionMatch(goldRows, predictedRows, { orderMatters });
      const strict = !goldErrored && res.ok && birdStrictMatch(goldRows, predictedRows);
      const mismatchShape = match ? undefined : classifyMismatch(res, predictedRows, goldRows);
      const isSuspectGold = (!match && SUSPECT_IDS.has(item.id)) || goldErrored;

      rec = {
        id: item.id,
        question: item.question,
        stratum: item.stratum,
        birdDifficulty: item._draft.birdDifficulty,
        flags: item._draft.flags ?? [],
        predictedSql,
        ...(res.ok ? {} : { failureStage: res.failure.stage, failureReason: res.failure.reason }),
        predictedRowCount: res.ok ? predictedRows.length : null,
        predictedRows: predictedRows.slice(0, ROW_CAP),
        goldSql: item.goldSql,
        goldRowCount: goldErrored ? null : goldRows.length,
        goldRows: goldRows.slice(0, ROW_CAP),
        goldErrored,
        ...(goldError ? { goldError } : {}),
        orderMatters,
        match: Boolean(match),
        birdStrictMatch: Boolean(strict),
        ...(mismatchShape ? { mismatchShape } : {}),
        isSuspectGold,
        traceSummary: summarizeTrace(res),
      };
    } catch (e) {
      // Hard infra failure (e.g. could not connect) for this item — record, keep going.
      rec = {
        id: item.id,
        question: item.question,
        stratum: item.stratum,
        birdDifficulty: item._draft.birdDifficulty,
        flags: item._draft.flags ?? [],
        predictedSql: null,
        failureStage: 'execute',
        failureReason: `benchmark-infra: ${String((e as Error)?.message ?? e)}`,
        predictedRowCount: null,
        predictedRows: [],
        goldSql: item.goldSql,
        goldRowCount: null,
        goldRows: [],
        goldErrored: false,
        orderMatters,
        match: false,
        birdStrictMatch: false,
        mismatchShape: 'pipeline-failure:execute',
        isSuspectGold: SUSPECT_IDS.has(item.id),
        traceSummary: null,
      };
    } finally {
      await handle?.close();
    }

    perQuestion.push(rec);
  }

  // ── Aggregate ────────────────────────────────────────────────────────────────
  const total = perQuestion.length;
  const matches = perQuestion.filter((r) => r.match).length;
  const suspectGold = perQuestion.filter((r) => r.isSuspectGold);
  const suspectIds = new Set(suspectGold.map((r) => r.id));
  const nonSuspect = perQuestion.filter((r) => !suspectIds.has(r.id));
  const nonSuspectMatches = nonSuspect.filter((r) => r.match).length;

  const acc = (m: number, n: number): number => (n === 0 ? 0 : Number((m / n).toFixed(4)));

  const groupBy = (key: (r: PerQuestion) => string): Record<string, { n: number; matches: number; accuracy: number }> => {
    const out: Record<string, { n: number; matches: number; accuracy: number }> = {};
    for (const r of perQuestion) {
      const k = key(r);
      out[k] ??= { n: 0, matches: 0, accuracy: 0 };
      out[k].n += 1;
      if (r.match) out[k].matches += 1;
    }
    for (const k of Object.keys(out)) out[k].accuracy = acc(out[k].matches, out[k].n);
    return out;
  };

  const pipelineFailuresByStage: Record<string, number> = {};
  for (const r of perQuestion) {
    if (r.failureStage) pipelineFailuresByStage[r.failureStage] = (pipelineFailuresByStage[r.failureStage] ?? 0) + 1;
  }

  const aggregate = {
    total,
    matches,
    executionAccuracyRaw: acc(matches, total),
    executionAccuracyAdjusted: acc(nonSuspectMatches, nonSuspect.length),
    adjustedDenominator: nonSuspect.length,
    byStratum: groupBy((r) => r.stratum),
    byDifficulty: groupBy((r) => r.birdDifficulty),
    pipelineFailuresByStage,
    suspectGold: suspectGold.map((r) => ({
      id: r.id,
      reason: r.goldErrored ? 'gold-execution-error' : 'known-suspect-id',
      match: r.match,
      mismatchShape: r.mismatchShape ?? null,
      birdStrictMatch: r.birdStrictMatch,
      flags: r.flags.map((f) => f.flag),
    })),
  };

  const runHeader: RunHeader & { goldFile: string; db: { host: string; port: string; name: string } } = {
    gitSha: gitSha(),
    modelString: PLANNER_MODEL,
    set: 'f1-draft',
    system: 'nl2sql-pipeline',
    ontologies: [],
    knobs: {},
    promptVersion,
    startedAt,
    goldFile: GOLD_FILE,
    db: { host: dbUrl.hostname, port: dbUrl.port, name: dbUrl.pathname.replace(/^\//, '') },
  };

  mkdirSync(resolve(process.cwd(), 'eval/results'), { recursive: true });
  const outPath = resolve(process.cwd(), `eval/results/benchmark-${unixTs}.json`);
  writeFileSync(outPath, `${JSON.stringify({ runHeader, aggregate, perQuestion }, null, 2)}\n`, { flag: 'wx' });

  console.error('\n══════════════════════════════════════════════════════════════');
  console.error(`raw execution accuracy     : ${matches}/${total} = ${(acc(matches, total) * 100).toFixed(1)}%`);
  console.error(
    `adjusted (excl. suspect)   : ${nonSuspectMatches}/${nonSuspect.length} = ${(acc(nonSuspectMatches, nonSuspect.length) * 100).toFixed(1)}%`,
  );
  console.error(`pipeline failures by stage : ${JSON.stringify(pipelineFailuresByStage)}`);
  console.error(`suspectGold count          : ${suspectGold.length}`);
  console.error(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
