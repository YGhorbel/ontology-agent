/**
 * Small synthetic gold + matcher cases. No real DB, no real gold — these exist ONLY to
 * exercise the matcher's edge cases and to drive an end-to-end runner→metrics test with a
 * fake System and a fake read-only DbHandle.
 *
 * Each `MATCHER_CASE` is a self-contained claim about `executionMatch`; each `SYNTHETIC`
 * item additionally carries the fake DB rows for its gold and candidate SQL so the runner
 * can execute them offline.
 */
import type { DbHandle, GoldItem, QueryResult, System } from './types.js';

// ---------------------------------------------------------------------------
// executionMatch edge cases (pure row-vs-row assertions).
// ---------------------------------------------------------------------------
export interface MatcherCase {
  name: string;
  goldRows: unknown[][];
  candRows: unknown[][];
  orderMatters: boolean;
  expected: boolean;
  why: string;
}

export const MATCHER_CASES: MatcherCase[] = [
  {
    name: 'order-by: same order matches',
    goldRows: [[1], [2], [3]],
    candRows: [[1], [2], [3]],
    orderMatters: true,
    expected: true,
    why: 'ordered sequences identical',
  },
  {
    name: 'order-by: wrong order fails',
    goldRows: [[1], [2], [3]],
    candRows: [[2], [1], [3]],
    orderMatters: true,
    expected: false,
    why: 'top-level ORDER BY → row sequence must match',
  },
  {
    name: 'no order: permutation matches (set)',
    goldRows: [[1], [2], [3]],
    candRows: [[3], [1], [2]],
    orderMatters: false,
    expected: true,
    why: 'BIRD set comparison is order-insensitive',
  },
  {
    name: 'float epsilon: 0.1+0.2 ≈ 0.3',
    goldRows: [[0.1 + 0.2]],
    candRows: [[0.3]],
    orderMatters: false,
    expected: true,
    why: 'relative epsilon 1e-6 absorbs float noise',
  },
  {
    name: 'integer exactness: 2 ≠ 3',
    goldRows: [[2]],
    candRows: [[3]],
    orderMatters: false,
    expected: false,
    why: 'integers compare exact',
  },
  {
    name: 'NULL equals NULL',
    goldRows: [[null, 1]],
    candRows: [[null, 1]],
    orderMatters: false,
    expected: true,
    why: 'NULL = NULL by decision',
  },
  {
    name: 'NULL ≠ value',
    goldRows: [[null]],
    candRows: [[0]],
    orderMatters: false,
    expected: false,
    why: 'NULL must not equal 0',
  },
  {
    name: 'text-vs-numeric coercion: "1" == 1',
    goldRows: [['1']],
    candRows: [[1]],
    orderMatters: false,
    expected: true,
    why: 'numeric-text columns surface as text in gold, number in cast',
  },
  {
    name: 'column-count mismatch fails',
    goldRows: [[1, 2]],
    candRows: [[1]],
    orderMatters: false,
    expected: false,
    why: 'different shape is a different answer',
  },
  {
    name: 'deliberately wrong candidate fails',
    goldRows: [[42]],
    candRows: [[99]],
    orderMatters: false,
    expected: false,
    why: 'a wrong number must never score correct',
  },
  {
    name: 'set collapses duplicates (BIRD property)',
    goldRows: [[1], [1], [2]],
    candRows: [[1], [2]],
    orderMatters: false,
    expected: true,
    why: 'documented EX consequence; numericCorrectness is the stricter scorer',
  },
  {
    name: 'both empty match',
    goldRows: [],
    candRows: [],
    orderMatters: false,
    expected: true,
    why: 'empty result equals empty result',
  },
  {
    name: 'empty vs non-empty fails',
    goldRows: [],
    candRows: [[1]],
    orderMatters: false,
    expected: false,
    why: 'missing rows are wrong',
  },
];

// ---------------------------------------------------------------------------
// BIRD-faithful strict EX cases: prove we reproduce `set(pred)==set(gt)` exactly —
// order-INsensitive always, NO float epsilon, NO numeric-text coercion.
// ---------------------------------------------------------------------------
export const STRICT_CASES: Array<{ name: string; gold: unknown[][]; cand: unknown[][]; expected: boolean }> = [
  { name: 'permutation matches (set)', gold: [[1], [2], [3]], cand: [[3], [1], [2]], expected: true },
  { name: 'order ignored even for ordered rows', gold: [[1], [2]], cand: [[2], [1]], expected: true },
  { name: 'NO float epsilon: 0.1+0.2 ≠ 0.3', gold: [[0.1 + 0.2]], cand: [[0.3]], expected: false },
  { name: 'numeric 1 == 1.0', gold: [[1]], cand: [[1.0]], expected: true },
  { name: 'NO coercion: text "1" ≠ numeric 1', gold: [['1']], cand: [[1]], expected: false },
  { name: 'NULL = NULL', gold: [[null]], cand: [[null]], expected: true },
  { name: 'NULL ≠ 0', gold: [[null]], cand: [[0]], expected: false },
  { name: 'duplicates collapse', gold: [[1], [1], [2]], cand: [[1], [2]], expected: true },
  { name: 'column-count mismatch fails', gold: [[1, 2]], cand: [[1]], expected: false },
  { name: 'both empty match', gold: [], cand: [], expected: true },
];

// ---------------------------------------------------------------------------
// Soft-F1 cases (hand-computed against mini_dev `calculate_f1_score`).
// ---------------------------------------------------------------------------
export const SOFTF1_CASES: Array<{ name: string; gold: unknown[][]; cand: unknown[][]; expected: number }> = [
  { name: 'identical → 1.0', gold: [[1], [2]], cand: [[1], [2]], expected: 1.0 },
  { name: 'column reorder still 1.0 (where EX strict = 0)', gold: [['a', 1]], cand: [[1, 'a']], expected: 1.0 },
  { name: 'completely wrong → 0', gold: [[1]], cand: [[2]], expected: 0.0 },
  { name: 'both empty → 1.0', gold: [], cand: [], expected: 1.0 },
  { name: 'half-matching row → 0.5', gold: [['a', 'b']], cand: [['a', 'x']], expected: 0.5 },
];

// ---------------------------------------------------------------------------
// Synthetic gold set for the end-to-end runner test (fake DB rows included).
// ---------------------------------------------------------------------------
export interface SyntheticItem {
  gold: GoldItem;
  candidateSql: string;
  /** Fake DB row sets keyed by exact SQL string (gold + candidate). */
  rowsBySql: Record<string, unknown[][]>;
  /** Our richer EX+ (order-aware + epsilon + numeric-text coercion). */
  expectExecutionMatch: boolean;
  /** Official BIRD EX (exact set equality). May differ from EX+ — those are the findings. */
  expectStrict: boolean;
  /** Defined only when the gold result is numeric (scalar/series). */
  expectNumeric?: boolean;
}

export const SYNTHETIC: SyntheticItem[] = [
  {
    gold: {
      id: 's1',
      dbName: 'synthdb',
      question: 'drivers ordered by wins desc',
      goldSql: 'SELECT name FROM d ORDER BY wins DESC',
      stratum: 'ordered',
    },
    candidateSql: 'SELECT name FROM drivers ORDER BY wins DESC',
    rowsBySql: {
      'SELECT name FROM d ORDER BY wins DESC': [['ayrton'], ['alain'], ['nigel']],
      'SELECT name FROM drivers ORDER BY wins DESC': [['ayrton'], ['alain'], ['nigel']],
    },
    expectExecutionMatch: true,
    expectStrict: true,
  },
  {
    gold: {
      id: 's2',
      dbName: 'synthdb',
      question: 'distinct teams',
      goldSql: 'SELECT DISTINCT team FROM t',
      stratum: 'set',
    },
    candidateSql: 'SELECT team FROM teams GROUP BY team',
    rowsBySql: {
      'SELECT DISTINCT team FROM t': [['mclaren'], ['ferrari'], ['williams']],
      'SELECT team FROM teams GROUP BY team': [['ferrari'], ['williams'], ['mclaren']],
    },
    expectExecutionMatch: true, // set comparison, order-insensitive
    expectStrict: true, // BIRD EX is also set-based → agrees here
  },
  {
    gold: {
      id: 's3',
      dbName: 'synthdb',
      question: 'total points',
      goldSql: 'SELECT SUM(points) FROM r',
      stratum: 'aggregate',
    },
    candidateSql: 'SELECT SUM(pts) FROM results',
    rowsBySql: {
      'SELECT SUM(points) FROM r': [[255]],
      'SELECT SUM(pts) FROM results': [[255]],
    },
    expectExecutionMatch: true,
    expectStrict: true,
    expectNumeric: true,
  },
  {
    gold: {
      id: 's4',
      dbName: 'synthdb',
      question: 'wrong aggregate',
      goldSql: 'SELECT AVG(x) FROM m',
      stratum: 'aggregate',
    },
    candidateSql: 'SELECT AVG(y) FROM m',
    rowsBySql: {
      'SELECT AVG(x) FROM m': [[10]],
      'SELECT AVG(y) FROM m': [[42]], // silently wrong number
    },
    expectExecutionMatch: false,
    expectStrict: false,
    expectNumeric: false,
  },
  {
    gold: {
      id: 's5',
      dbName: 'synthdb',
      question: 'code as text',
      goldSql: 'SELECT code FROM c',
      stratum: 'text-numeric',
    },
    candidateSql: 'SELECT CAST(code AS INT) FROM c',
    rowsBySql: {
      'SELECT code FROM c': [['1'], ['2']],
      'SELECT CAST(code AS INT) FROM c': [[1], [2]],
    },
    expectExecutionMatch: true, // numeric-text coercion (EX+ accepts the cast)
    expectStrict: false, // BIRD EX: text '1' ≠ numeric 1 → fails the cast. THE divergence.
  },
  {
    gold: {
      id: 's6',
      dbName: 'synthdb',
      question: 'broken candidate sql',
      goldSql: 'SELECT 1',
      stratum: 'error',
    },
    candidateSql: 'SELECT FROM WHERE', // unmapped → fake DB throws
    rowsBySql: {
      'SELECT 1': [[1]],
    },
    expectExecutionMatch: false,
    expectStrict: false,
  },
  {
    // Right rows, WRONG order on an ORDER BY question: EX+ (order-aware) fails it, but BIRD
    // EX is set-based and PASSES it — the opposite-direction divergence from s5.
    gold: {
      id: 's7',
      dbName: 'synthdb',
      question: 'drivers ranked by points',
      goldSql: 'SELECT name FROM d2 ORDER BY pts DESC',
      stratum: 'ordered',
    },
    candidateSql: 'SELECT name FROM drivers2 ORDER BY pts ASC',
    rowsBySql: {
      'SELECT name FROM d2 ORDER BY pts DESC': [['a'], ['b'], ['c']],
      'SELECT name FROM drivers2 ORDER BY pts ASC': [['c'], ['b'], ['a']],
    },
    expectExecutionMatch: false, // EX+ requires the order to match
    expectStrict: true, // BIRD EX ignores order → counts it correct
  },
];

/** A System that looks up a canned candidate SQL by question (no LLM). */
export function makeSyntheticSystem(items: SyntheticItem[] = SYNTHETIC): System {
  const byQuestion = new Map(items.map((i) => [i.gold.question, i.candidateSql]));
  return async ({ question }) => {
    const sql = byQuestion.get(question);
    if (sql === undefined) throw new Error(`no synthetic candidate for question: ${question}`);
    return { sql, tokens: { prompt: 10, completion: 5 } };
  };
}

/** A read-only fake DbHandle backed by an in-memory SQL→rows map (throws on unknown SQL). */
export function makeFakeDb(items: SyntheticItem[] = SYNTHETIC, dbName = 'synthdb'): DbHandle {
  const rows: Record<string, unknown[][]> = {};
  for (const it of items) Object.assign(rows, it.rowsBySql);
  return {
    dbName,
    async query(sql: string): Promise<QueryResult> {
      const r = rows[sql];
      if (r === undefined) throw new Error(`fake DB: unmapped SQL: ${sql}`);
      const width = r.length > 0 ? (r[0]?.length ?? 0) : 0;
      return { columns: Array.from({ length: width }, (_, i) => `c${i}`), rows: r };
    },
  };
}
