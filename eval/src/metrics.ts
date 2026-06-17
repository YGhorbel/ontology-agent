/**
 * Aggregate one run file (JSONL + .header.json sidecar) into a report.
 *
 * Metrics & exact formulas (also in docs/eval.md):
 *   - execution accuracy  = (# records with executionMatch=true) / (# records)
 *   - numeric correctness = (# with numericCorrectness=true) / (# where numericCorrectness present)
 *   - per-stratum         = the same two ratios, partitioned by `stratum`
 *   - latency p50 / p95   = nearest-rank percentiles of latencyMs over all records
 *   - tokens-per-correct  = (Σ prompt+completion tokens) / (# executionMatch=true)   [∞ if 0]
 *   - join-path P/R       = over a (candidate, gold) pairing: precision = |C∩G|/|C|,
 *                           recall = |C∩G|/|G|, with empty-set conventions (see joinPathPRF).
 *
 * `extractJoinPairs` is re-exported here as the metrics module's public join extractor
 * (implemented in sql.ts so the parser is reused in one place).
 */
import { readFileSync } from 'node:fs';
import type { RunHeader, RunRecord } from './types.js';
import { extractJoinPairs } from './sql.js';
import { computeRVES } from './ves.js';

export { extractJoinPairs } from './sql.js';

export interface StratumReport {
  stratum: string;
  n: number;
  /** Official BIRD EX accuracy (comparable headline). */
  executionAccuracyStrict: number;
  /** Our richer order-aware EX+ accuracy. */
  executionAccuracy: number;
  softF1Mean: number;
  numericApplicable: number;
  numericCorrectness: number | null;
}

export interface RunReport {
  header: RunHeader | null;
  n: number;
  /** Official BIRD Execution Accuracy — the comparable, headline number. */
  executionAccuracyStrict: number;
  /** Our richer EX+ (order-aware + epsilon + numeric-text). Diagnostic, not comparable. */
  executionAccuracy: number;
  /** #items where strict EX and EX+ disagree — the methodology divergence, surfaced. */
  strictVsPlusDisagreements: number;
  /** Mean official BIRD-mini-dev Soft F1. */
  softF1Mean: number;
  /** Reward-based Valid Efficiency Score (needs real-DB timing to be meaningful). */
  rves: number;
  numericApplicable: number;
  numericCorrectness: number | null;
  errors: number;
  latencyP50: number;
  latencyP95: number;
  totalTokens: number;
  tokensPerCorrect: number; // Infinity when zero correct (uses strict EX)
  perStratum: StratumReport[];
}

/** Nearest-rank percentile (p in [0,1]) of a numeric sample. 0 for an empty sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[idx] ?? 0;
}

/**
 * Join-path precision/recall/F1 between a candidate query and a gold query.
 * Empty-set conventions (documented): if the GOLD has no joins, recall is 1 (nothing to
 * miss); if the CANDIDATE has no joins, precision is 1 (nothing wrong asserted). This makes
 * gold-vs-gold on a join-free query score 1.0/1.0, same as a joined query.
 */
export function joinPathPRF(candidateSql: string, goldSql: string): { precision: number; recall: number; f1: number } {
  const cand = extractJoinPairs(candidateSql);
  const gold = extractJoinPairs(goldSql);
  let inter = 0;
  for (const e of cand) if (gold.has(e)) inter += 1;
  const precision = cand.size === 0 ? 1 : inter / cand.size;
  const recall = gold.size === 0 ? 1 : inter / gold.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/** Parse a run JSONL file into records (ignores blank lines). */
export function loadRunRecords(jsonlPath: string): RunRecord[] {
  return readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunRecord);
}

/** Load the `.header.json` sidecar next to a run file, or null if absent. */
export function loadRunHeader(jsonlPath: string): RunHeader | null {
  const headerPath = jsonlPath.replace(/\.jsonl$/, '.header.json');
  try {
    return JSON.parse(readFileSync(headerPath, 'utf8')) as RunHeader;
  } catch {
    return null;
  }
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function aggregate(records: RunRecord[], header: RunHeader | null = null): RunReport {
  const n = records.length;
  const correctStrict = records.filter((r) => r.executionMatchStrict).length;
  const numericRecords = records.filter((r) => r.numericCorrectness !== undefined);
  const numericCorrect = numericRecords.filter((r) => r.numericCorrectness === true).length;
  const totalTokens = records.reduce((s, r) => s + r.tokens.prompt + r.tokens.completion, 0);
  const latencies = records.map((r) => r.latencyMs);
  const disagreements = records.filter((r) => r.executionMatchStrict !== r.executionMatch).length;

  const byStratum = new Map<string, RunRecord[]>();
  for (const r of records) {
    const arr = byStratum.get(r.stratum) ?? [];
    arr.push(r);
    byStratum.set(r.stratum, arr);
  }
  const perStratum: StratumReport[] = [...byStratum.entries()]
    .map(([stratum, rs]) => {
      const num = rs.filter((r) => r.numericCorrectness !== undefined);
      const numOk = num.filter((r) => r.numericCorrectness === true).length;
      return {
        stratum,
        n: rs.length,
        executionAccuracyStrict: rs.filter((r) => r.executionMatchStrict).length / rs.length,
        executionAccuracy: rs.filter((r) => r.executionMatch).length / rs.length,
        softF1Mean: mean(rs.map((r) => r.softF1)),
        numericApplicable: num.length,
        numericCorrectness: num.length === 0 ? null : numOk / num.length,
      };
    })
    .sort((a, b) => a.stratum.localeCompare(b.stratum));

  return {
    header,
    n,
    executionAccuracyStrict: n === 0 ? 0 : correctStrict / n,
    executionAccuracy: n === 0 ? 0 : records.filter((r) => r.executionMatch).length / n,
    strictVsPlusDisagreements: disagreements,
    softF1Mean: mean(records.map((r) => r.softF1)),
    rves: computeRVES(records),
    numericApplicable: numericRecords.length,
    numericCorrectness: numericRecords.length === 0 ? null : numericCorrect / numericRecords.length,
    errors: records.filter((r) => r.error !== undefined).length,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    totalTokens,
    tokensPerCorrect: correctStrict === 0 ? Infinity : totalTokens / correctStrict,
    perStratum,
  };
}

/** Aggregate a run file (records + sidecar header) into a report. */
export function reportRunFile(jsonlPath: string): RunReport {
  return aggregate(loadRunRecords(jsonlPath), loadRunHeader(jsonlPath));
}

function pct(x: number | null): string {
  return x === null ? '   n/a' : `${(x * 100).toFixed(1)}%`;
}

/** Render a report as a human-readable text block. */
export function formatReport(rep: RunReport): string {
  const lines: string[] = [];
  const h = rep.header;
  lines.push('═'.repeat(72));
  if (h) {
    lines.push(`run: set="${h.set}" system="${h.system}" model="${h.modelString}"`);
    lines.push(`gitSha=${h.gitSha}  promptVersion=${h.promptVersion}  startedAt=${h.startedAt}`);
    const onto = h.ontologies.map((o) => `${o.dbName}:${o.buildNumber ?? 'null'}`).join(', ') || '(none)';
    lines.push(`ontologies: ${onto}`);
  } else {
    lines.push('run: (no header sidecar found)');
  }
  lines.push('─'.repeat(72));
  lines.push(`items                : ${rep.n}   (errors: ${rep.errors})`);
  lines.push(`EX (BIRD, headline)  : ${pct(rep.executionAccuracyStrict)}  (${Math.round(rep.executionAccuracyStrict * rep.n)}/${rep.n})`);
  lines.push(`EX+ (order/eps/coerce): ${pct(rep.executionAccuracy)}   [${rep.strictVsPlusDisagreements} disagree with BIRD EX]`);
  lines.push(`Soft-F1 (BIRD)       : ${pct(rep.softF1Mean)}`);
  lines.push(`numeric correctness  : ${pct(rep.numericCorrectness)}  (over ${rep.numericApplicable} numeric-gold items)`);
  lines.push(`R-VES (BIRD)         : ${rep.rves.toFixed(2)}  (needs real-DB timing to be meaningful)`);
  lines.push(`latency  p50 / p95   : ${rep.latencyP50.toFixed(3)} / ${rep.latencyP95.toFixed(3)} ms`);
  lines.push(
    `tokens / EX-correct  : ${rep.tokensPerCorrect === Infinity ? '∞ (0 correct)' : rep.tokensPerCorrect.toFixed(1)}  (total ${rep.totalTokens})`,
  );
  lines.push('─'.repeat(72));
  lines.push('per stratum          :   n    EX(BIRD)  EX+     Soft-F1  numeric');
  for (const s of rep.perStratum) {
    lines.push(
      `  ${s.stratum.padEnd(18)} ${String(s.n).padStart(3)}   ${pct(s.executionAccuracyStrict).padStart(6)}   ${pct(s.executionAccuracy).padStart(6)}  ${pct(s.softF1Mean).padStart(6)}  ${pct(s.numericCorrectness).padStart(6)} (${s.numericApplicable})`,
    );
  }
  lines.push('═'.repeat(72));
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// CLI:  pnpm run eval:report -- --run eval/runs/<file>.jsonl
// --------------------------------------------------------------------------
function parseArgs(argv: string[]): { run?: string } {
  const out: { run?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--run') {
      out.run = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { run } = parseArgs(process.argv.slice(2));
  if (!run) {
    console.error('usage: eval:report -- --run eval/runs/<file>.jsonl');
    process.exit(2);
  }
  console.log(formatReport(reportRunFile(run)));
}
