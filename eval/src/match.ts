/**
 * The core scorers. Two INDEPENDENT functions, each individually unit-tested, because
 * the whole harness is only trustworthy if a wrong SQL answer can never score correct.
 *
 *   executionMatch    — BIRD-style execution accuracy (EX). The comparable, published metric.
 *   numericCorrectness — a stricter single-value/series check that EXISTS because EX
 *                        under-detects silent-wrong-number failures.
 *
 * Every comparison decision below is explicit and documented, with its consequence.
 */

// ---------------------------------------------------------------------------
// Cell comparison primitives (shared by both scorers, kept deliberately simple).
// ---------------------------------------------------------------------------

/** Relative epsilon for float comparison. BIRD treats near-equal floats as equal; we
 *  mirror that so transpiled gold and generated SQL don't diverge on rounding. */
export const FLOAT_REL_EPS = 1e-6;

/** A value that is a JS number, or text that is exactly a number (e.g. '1', '-2.5', '1e3'). */
function coerceNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const t = v.trim();
    // strict numeric text only — empty, words, or '12abc' are NOT numbers
    if (t === '' || !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Compare two scalar cells for matcher equality. Decisions, each with its rationale/risk:
 *  - NULL equals NULL (both null/undefined → equal); null vs non-null → not equal.
 *  - Numbers: relative epsilon `FLOAT_REL_EPS` (1e-6). Integers compare exact under the
 *    same rule (their relative error is 0). Risk: two genuinely different values closer
 *    than 1e-6 relative would tie — negligible for analytics results.
 *  - NUMERIC-LOOKING TEXT is coerced to a number before comparing (so '1' === 1, '2.0' === 2).
 *    DELIBERATE: our `isNumericText` columns legitimately surface a value as text in gold
 *    and as a number in a generated cast (or vice-versa). RISK: a zero-padded code like
 *    '007' would equal 7, and '1.0' would equal '1'; acceptable because these columns are
 *    semantically numeric. Non-numeric text falls back to exact string equality.
 *  - Everything else: strict `===` after string coercion of booleans/dates via String().
 */
export function cellsEqual(a: unknown, b: unknown): boolean {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull && bNull; // NULL = NULL, NULL ≠ value

  const an = coerceNumber(a);
  const bn = coerceNumber(b);
  if (an !== null && bn !== null) {
    if (an === bn) return true;
    const scale = Math.max(Math.abs(an), Math.abs(bn));
    return Math.abs(an - bn) <= FLOAT_REL_EPS * (scale === 0 ? 1 : scale);
  }
  // one numeric, one not → not equal (e.g. 1 vs 'abc'); both non-numeric → exact string
  if (an !== null || bn !== null) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return String(a) === String(b);
}

/** Row (tuple) equality BY POSITION. Assumes equal length (caller checks column count). */
function rowsEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!cellsEqual(a[i], b[i])) return false;
  }
  return true;
}

/** Canonical key for a row, used for multiset/set comparison (order-insensitive mode). */
function rowKey(row: unknown[]): string {
  return JSON.stringify(
    row.map((v) => {
      if (v === null || v === undefined) return ['␀'];
      const n = coerceNumber(v);
      // round to the float epsilon grid so near-equal floats share a key
      if (n !== null) return ['#', n === 0 ? 0 : Number(n.toPrecision(12))];
      return ['$', String(v)];
    }),
  );
}

export interface ExecutionMatchOptions {
  /** Derived by the runner from the gold parse: true iff the gold has a top-level ORDER BY. */
  orderMatters: boolean;
}

/**
 * BIRD-style Execution Accuracy (EX).
 *
 * Compares the two result sets as SETS of row-tuples (this is the published EX metric;
 * we match it to stay comparable with reported numbers). CONSEQUENCE, documented: a SET
 * comparison does NOT distinguish duplicate rows — `[(1),(1)]` and `[(1)]` are treated as
 * equal. That is BIRD's behaviour and we keep it for comparability (numericCorrectness is
 * the stricter scorer when duplicates/exact values matter).
 *
 * Decisions:
 *  - Columns compared BY POSITION, never by name: generated SQL won't reproduce gold
 *    aliases. We FIRST assert column COUNT matches; a count mismatch fails the match
 *    immediately (a different shape is a different answer).
 *  - orderMatters (from the gold's top-level ORDER BY): when true, compare as ORDERED
 *    sequences (row i vs row i); when false, order-insensitive set comparison.
 *  - Cell equality per `cellsEqual` (float epsilon, NULL=NULL, numeric-text coercion).
 */
export function executionMatch(
  goldRows: unknown[][],
  candRows: unknown[][],
  opts: ExecutionMatchOptions,
): boolean {
  // Column-count gate (by position): compare the widths of the first row of each.
  const goldWidth = goldRows.length > 0 ? (goldRows[0]?.length ?? 0) : 0;
  const candWidth = candRows.length > 0 ? (candRows[0]?.length ?? 0) : 0;
  if (goldRows.length > 0 && candRows.length > 0 && goldWidth !== candWidth) return false;
  // Both empty → equal (matching empty results). One empty, one not → not equal.
  if (goldRows.length === 0 || candRows.length === 0) {
    return goldRows.length === 0 && candRows.length === 0;
  }

  if (opts.orderMatters) {
    if (goldRows.length !== candRows.length) return false;
    for (let i = 0; i < goldRows.length; i += 1) {
      if (!rowsEqual(goldRows[i] as unknown[], candRows[i] as unknown[])) return false;
    }
    return true;
  }

  // Order-insensitive SET comparison (BIRD default). Duplicates collapse — documented above.
  const goldSet = new Set(goldRows.map(rowKey));
  const candSet = new Set(candRows.map(rowKey));
  if (goldSet.size !== candSet.size) return false;
  for (const k of goldSet) if (!candSet.has(k)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// numericCorrectness — the second, stricter scorer.
// ---------------------------------------------------------------------------

/** A single aggregate, or a labeled series (e.g. a per-group total). */
export type NumericGold =
  | { kind: 'scalar'; value: number }
  | { kind: 'series'; points: Array<{ label: string; value: number }> };

export interface NumericMatchResult {
  ok: boolean;
  /** Largest absolute deviation observed (for reporting), or null if shapes are incompatible. */
  maxAbsDiff: number | null;
  reason?: string;
}

/**
 * Compare a numeric gold against a candidate with absolute tolerance `tol`.
 *
 * WHY THIS EXISTS (intentional divergence from executionMatch, itself a finding we report):
 * EX under-detects the "silent wrong number" failure class (H2) — a candidate can EX-match
 * because the result SET coincides, or because a wrong gold and a wrong candidate agree,
 * while the actual aggregate is off. numericCorrectness pins the value(s) directly with a
 * tolerance, so a wrong magnitude is caught even when EX is satisfied. The two scorers are
 * independent on purpose; their disagreement is data, not a bug.
 *
 * Series are matched by LABEL (order-insensitive): same label set, each value within tol.
 */
export function numericCorrectness(
  gold: NumericGold,
  cand: NumericGold,
  tol: number,
): NumericMatchResult {
  if (gold.kind === 'scalar') {
    if (cand.kind !== 'scalar') return { ok: false, maxAbsDiff: null, reason: 'shape: expected scalar' };
    const diff = Math.abs(gold.value - cand.value);
    return { ok: diff <= tol, maxAbsDiff: diff };
  }
  // series
  if (cand.kind !== 'series') return { ok: false, maxAbsDiff: null, reason: 'shape: expected series' };
  const candMap = new Map(cand.points.map((p) => [p.label, p.value]));
  if (candMap.size !== gold.points.length || gold.points.length !== cand.points.length) {
    return { ok: false, maxAbsDiff: null, reason: 'series: label sets differ in size' };
  }
  let maxDiff = 0;
  for (const g of gold.points) {
    const cv = candMap.get(g.label);
    if (cv === undefined) return { ok: false, maxAbsDiff: null, reason: `series: missing label "${g.label}"` };
    const diff = Math.abs(g.value - cv);
    if (diff > maxDiff) maxDiff = diff;
  }
  return { ok: maxDiff <= tol, maxAbsDiff: maxDiff };
}

/**
 * Derive a NumericGold from a result set, or null if the result is not numeric in shape.
 * Used by the runner to decide whether numericCorrectness APPLIES to an item:
 *  - 1 row × 1 col, numeric            → scalar
 *  - N rows × 2 cols, 2nd col numeric  → series labeled by the 1st column (stringified)
 * Anything else → null (numericCorrectness is N/A for that item).
 */
export function asNumericGold(rows: unknown[][]): NumericGold | null {
  if (rows.length === 1 && (rows[0]?.length ?? 0) === 1) {
    const n = toNum(rows[0]?.[0]);
    return n === null ? null : { kind: 'scalar', value: n };
  }
  if (rows.length >= 1 && rows.every((r) => r.length === 2)) {
    const points: Array<{ label: string; value: number }> = [];
    for (const r of rows) {
      const n = toNum(r[1]);
      if (n === null) return null;
      points.push({ label: String(r[0]), value: n });
    }
    return { kind: 'series', points };
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) {
    return Number(v.trim());
  }
  return null;
}

// ---------------------------------------------------------------------------
// BIRD-FAITHFUL scorers — exact ports of bird-bench/mini_dev evaluation code, so
// our headline numbers are comparable with the published leaderboard. These do NOT
// apply our float-epsilon / numeric-text / order-aware policies; they reproduce the
// reference semantics 1:1. Use `executionMatch`/`numericCorrectness` for our richer
// diagnostics, and these for comparability.
// ---------------------------------------------------------------------------

/**
 * Python-faithful cell key. Mirrors how psycopg2/sqlite values compare inside a
 * Python `set` of row-tuples:
 *  - None ≡ None only (→ 'N');
 *  - numbers compare by value with `1 == 1.0` (→ 'n:<value>'), but with NO epsilon —
 *    `0.1+0.2` and `0.3` are DIFFERENT (exactly as Python);
 *  - numeric-looking TEXT is NOT a number — '1' (text) ≠ 1 (numeric) (→ 's:1' vs 'n:1'),
 *    matching Python `'1' == 1 → False`. (Requires the DbHandle to surface numeric
 *    columns as JS numbers, which eval/src/db.ts configures; see its note.)
 *  - booleans → 'b:<value>'.
 * KNOWN LIMIT: int8/numeric beyond 2^53 lose precision via JS number; psycopg2 keeps it
 * exact. Negligible for result-set equality in practice; documented in docs/eval.md.
 */
function strictCellKey(v: unknown): string {
  if (v === null || v === undefined) return 'N';
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'bigint') return `n:${Number(v)}`;
  if (typeof v === 'boolean') return `b:${v}`;
  return `s:${String(v)}`;
}

/** Python-faithful cell equality (used by strict EX membership and Soft-F1). */
export function cellEqualStrict(a: unknown, b: unknown): boolean {
  return strictCellKey(a) === strictCellKey(b);
}

function strictRowKey(row: unknown[]): string {
  return JSON.stringify(row.map(strictCellKey));
}

/**
 * Official BIRD Execution Accuracy (EX): `set(predicted) == set(ground_truth)`.
 * Order-insensitive ALWAYS (no ORDER BY handling), columns by position (tuples),
 * exact value equality (no epsilon, no text↔number coercion), duplicates collapsed.
 * This is the comparable, published metric — see docs/adr/000-eval-methodology.md.
 */
export function birdStrictMatch(goldRows: unknown[][], candRows: unknown[][]): boolean {
  const g = new Set(goldRows.map(strictRowKey));
  const c = new Set(candRows.map(strictRowKey));
  if (g.size !== c.size) return false;
  for (const k of g) if (!c.has(k)) return false;
  return true;
}

/** Per-row column-set match (Soft-F1 helper), faithful to mini_dev `calculate_row_match`. */
function rowMatch(predRow: unknown[], gtRow: unknown[]): { match: number; predOnly: number; truthOnly: number } {
  const total = gtRow.length;
  if (total === 0) return { match: 0, predOnly: 0, truthOnly: 0 };
  let matches = 0;
  let predOnly = 0;
  for (const pv of predRow) {
    if (gtRow.some((x) => cellEqualStrict(pv, x))) matches += 1;
    else predOnly += 1;
  }
  let truthOnly = 0;
  for (const tv of gtRow) if (!predRow.some((x) => cellEqualStrict(tv, x))) truthOnly += 1;
  return { match: matches / total, predOnly: predOnly / total, truthOnly: truthOnly / total };
}

/** Dedup row tuples preserving first-occurrence order (≡ Python `list(dict.fromkeys(...))`). */
function dedupRows(rows: unknown[][]): unknown[][] {
  const seen = new Set<string>();
  const out: unknown[][] = [];
  for (const r of rows) {
    const k = strictRowKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/**
 * Official BIRD-mini-dev Soft F1 — exact port of `calculate_f1_score`. Robust to COLUMN
 * reordering (within-row set membership) while pairing rows BY INDEX after de-duplication.
 * This is mini_dev's own answer to EX brittleness; we report it alongside strict EX.
 * Returns a score in [0,1] (1.0 when both sides are empty).
 */
export function softF1(goldRows: unknown[][], candRows: unknown[][]): number {
  if (goldRows.length === 0 && candRows.length === 0) return 1.0;
  const predicted = dedupRows(candRows);
  const ground = dedupRows(goldRows);

  const matchScores: number[] = [];
  const predOnly: number[] = [];
  const truthOnly: number[] = [];

  for (let i = 0; i < ground.length; i += 1) {
    if (i >= predicted.length) {
      matchScores.push(0);
      truthOnly.push(1);
      predOnly.push(0);
      continue;
    }
    const m = rowMatch(predicted[i] as unknown[], ground[i] as unknown[]);
    matchScores.push(m.match);
    predOnly.push(m.predOnly);
    truthOnly.push(m.truthOnly);
  }
  for (let i = 0; i < predicted.length - ground.length; i += 1) {
    matchScores.push(0);
    predOnly.push(1);
    truthOnly.push(0);
  }

  const tp = matchScores.reduce((s, x) => s + x, 0);
  const fp = predOnly.reduce((s, x) => s + x, 0);
  const fn = truthOnly.reduce((s, x) => s + x, 0);
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}
