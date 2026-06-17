# NL2SQL evaluation harness (core)

The measuring instrument for the NL2SQL research system: a result **matcher**, a
system-agnostic **runner** with immutable logging, and a **metrics** aggregator. It is
built so a wrong SQL answer can never score correct. This document is the contract; the
data substrate (11 BIRD mini-dev Postgres DBs) and gold authoring are separate tasks.

> Scope of the current sprint: matcher + runner + metrics + tests on **synthetic
> fixtures**. No LLM, no gold authoring, no ontology generation, nothing from Sprint 1+.

## The frozen `System` interface

Everything under test plugs in as one type ([eval/src/types.ts](../eval/src/types.ts)) —
the floor baseline, the five-stage pipeline, and competitor reimplementations alike. It is
frozen; changing its shape requires an ADR.

```ts
type System = (input: {
  question: string;
  dbName: string;
  ontology: object;     // generator's { 'qsl:ontology', '@graph' }; {} when absent
  db: DbHandle;         // read-only, statement-timeout bounded
}) => Promise<{
  sql: string;
  artifacts?: { anchors?; subgraph?; ir?; certificate? };  // optional, empty for now
  tokens?: { prompt: number; completion: number };          // optional
}>;
```

`DbHandle.query(sql)` returns `{ columns: string[]; rows: unknown[][] }` — rows are
**positional tuples** (`rows[i][j]`), because the matcher compares by position, not name.

## Metric suite (BIRD-faithful headline + richer diagnostics)

The harness reports the official **bird-bench/mini_dev** metrics as the comparable headline,
plus our own diagnostics. The BIRD-faithful scorers are **exact ports** of the upstream
Python, **validated value-for-value** against `evaluation_ex.py` / `evaluation_f1.py` /
`evaluation_ves.py` (a parity check on the synthetic fixtures passes).

| Metric | Source | Role |
|---|---|---|
| **EX (BIRD)** `birdStrictMatch` | `calculate_ex`: `set(pred)==set(gt)` | **headline, leaderboard-comparable** |
| **Soft-F1 (BIRD)** `softF1` | `calculate_f1_score` | column-order-robust, BIRD's own EX-brittleness remedy |
| **R-VES (BIRD)** `vesReward`/`computeRVES` | `evaluation_ves.py` | efficiency (needs real-DB timing) |
| **EX+** `executionMatch` | ours | order-aware + float-epsilon + numeric-text (diagnostic) |
| **numericCorrectness** | ours | H2 silent-wrong-number detector |
| **join-path P/R** | ours | structural (Sprint 2) |

**The strict-EX vs EX+ gap is reported, not hidden** (`strictVsPlusDisagreements`). The two
diverge in exactly three places, each a documented finding:
- **order** — BIRD EX never checks row order; EX+ does (when the gold has a top-level
  ORDER BY). A right-rows/wrong-order answer: BIRD scores 1, EX+ scores 0.
- **floats** — BIRD EX is exact (`0.1+0.2 ≠ 0.3`); EX+ uses 1e-6 relative epsilon.
- **numeric text** — BIRD EX treats text `'1'` ≠ numeric `1` (so a cast over a text column
  *fails* official EX); EX+ coerces. This is real BIRD brittleness that EX+ and Soft-F1 each
  soften by a different route.

> Numeric typing: [eval/src/db.ts](../eval/src/db.ts) parses pg `int8`/`numeric`/`float` to
> JS numbers (per-client, not global) so strict EX matches Python's `1 == 1.0` while keeping
> text columns as strings. Known limit: int8/numeric beyond 2^53 lose precision vs psycopg2.

## Matcher decisions (with rationale)

The richer diagnostic scorers ([eval/src/match.ts](../eval/src/match.ts)), each unit-tested.

### `executionMatch(goldRows, candRows, { orderMatters })` → boolean

Mirrors **BIRD's Execution Accuracy (EX)** so our numbers are comparable with published
ones. Decisions:

| Decision | Rule | Rationale / consequence |
|---|---|---|
| **Set comparison** | Compare results as **sets** of row-tuples | This is BIRD's EX. **Consequence:** duplicate rows are *not* distinguished — `[(1),(1)]` equals `[(1)]`. Kept for comparability; `numericCorrectness` is the stricter scorer when multiplicity/magnitude matters. |
| **By position** | Columns compared by index, never by name | Generated SQL won't reproduce gold aliases. Column **count** is asserted first; a count mismatch fails the match immediately (different shape = different answer). |
| **orderMatters** | `true` ⇔ the gold's **top-level** `ORDER BY` (derived from the parse) | When `true`, compare as ordered sequences (row *i* vs row *i*); when `false`, order-insensitive set. ORDER BY inside a subquery does **not** count. Unparseable gold → `false` (BIRD default). |
| **Floats** | Relative epsilon **1e-6** | Absorbs transpile/round noise. Integers compare exact under the same rule (relative error 0). |
| **NULL** | `NULL = NULL`; `NULL ≠ value` | A null and a 0/'' are different answers. |
| **Numeric text** | Numeric-looking text coerced to number (`'1' == 1`, `'2.0' == 2`) | **Deliberate:** `isNumericText` columns legitimately appear as text in gold and as a cast number in candidates. **Risk:** zero-padded codes (`'007' == 7`) and `'1.0' == '1'` tie; accepted because these columns are semantically numeric. Non-numeric text falls back to exact string equality. |

### `numericCorrectness(gold, cand, tol)` → { ok, maxAbsDiff }

Compares a single aggregate (`scalar`) or a labeled `series` (matched by label,
order-insensitive) with absolute tolerance `tol` (default `1e-6`, env `EVAL_NUMERIC_TOL`).

**Why a second scorer exists (intentional divergence — itself a finding we report):** EX
under-detects the *silent-wrong-number* failure class (H2). A candidate can EX-match because
the result *set* coincides, or because a wrong gold and wrong candidate happen to agree,
while the true magnitude is off. `numericCorrectness` pins the value(s) directly. The two
scorers are independent on purpose; their **disagreement is data**. The runner applies it
only to items whose gold result is numeric in shape (1×1 numeric → scalar; N×2 with a
numeric 2nd column → series); other items report no `numericCorrectness`.

## Runner

[eval/src/runner.ts](../eval/src/runner.ts) — `runSystem(system, gold, opts)`:

- opens one **read-only** `DbHandle` per database ([eval/src/db.ts](../eval/src/db.ts):
  `BEGIN TRANSACTION READ ONLY` + `SET statement_timeout`, `rowMode:'array'` for positional
  rows; env `EVAL_STMT_TIMEOUT_MS`, default 30 000);
- per item: calls the System, executes candidate SQL (and gold SQL, unless `goldRows` are
  pre-captured) read-only, derives `orderMatters` once from the gold parse, scores with both
  scorers, times it, and captures any error instead of crashing;
- writes one JSONL line per item to `eval/runs/<ISO>-<set>-<system>.jsonl`, **flushed
  (fsync) per line** (crash-safe), with `wx` so a run file is **never overwritten**;
- writes a citable **`.header.json` sidecar**: `gitSha`, `modelString` (`"none"` here),
  `set`, `system`, per-DB ontology `sourceFingerprint`+`buildNumber` (read from each supplied
  ontology header; `null` when none), `knobs`, `promptVersion` (`"none"`), `startedAt`.

## Metrics & exact formulas

[eval/src/metrics.ts](../eval/src/metrics.ts) aggregates a run file:

- **EX (BIRD, headline)** = `#{executionMatchStrict=true} / #records`
- **EX+ (diagnostic)** = `#{executionMatch=true} / #records`; `strictVsPlusDisagreements` =
  `#{executionMatchStrict ≠ executionMatch}`
- **Soft-F1 (BIRD)** = mean of per-item `softF1`
- **R-VES (BIRD)** = `mean( sqrt(reward)*100 )`, reward 0 unless EX-correct, else stepped on
  `goldExecMs/candExecMs` (see [eval/src/ves.ts](../eval/src/ves.ts))
- **execution accuracy (legacy alias)** = `#{executionMatch=true} / #records`
- **numeric correctness** = `#{numericCorrectness=true} / #{numericCorrectness present}`
- **per-stratum** = the same two ratios partitioned by `stratum`
- **latency p50 / p95** = nearest-rank percentiles of `latencyMs`
- **tokens-per-correct** = `Σ(prompt+completion) / #{executionMatch=true}` (`∞` if 0 correct)
- **join-path precision/recall/F1** via `extractJoinPairs(sql)` (parses with the reused
  `pgsql-ast-parser`, returns canonical alias-resolved `table.col=table.col` edges):
  `precision = |C∩G|/|C|`, `recall = |C∩G|/|G|`. Empty-set conventions: gold with no joins →
  recall 1; candidate with no joins → precision 1 (so gold-vs-gold is always 1.0/1.0).
  **Validated now:** `extractJoinPairs(gold)` vs itself scores precision=recall=1.0 on every
  synthetic fixture — the extractor is proven before Sprint 2 consumes it.

## Running it

```bash
pnpm run test:eval                                   # the instrument's proof (41 tests)
pnpm run eval:report -- --run eval/runs/<file>.jsonl # render a run report
```

Sample report over the synthetic run:

```
items                : 7   (errors: 1)
EX (BIRD, headline)  : 57.1%  (4/7)
EX+ (order/eps/coerce): 57.1%   [2 disagree with BIRD EX]
Soft-F1 (BIRD)       : 33.3%
numeric correctness  : 50.0%  (over 2 numeric-gold items)
R-VES (BIRD)         : 63.89  (needs real-DB timing to be meaningful)
latency  p50 / p95   : 1.363 / 9.209 ms
tokens / EX-correct  : 26.3  (total 105)
per stratum          :   n    EX(BIRD)  EX+     Soft-F1  numeric
  aggregate            2    50.0%    50.0%   50.0%   50.0% (2)
  error                1     0.0%     0.0%    0.0%     n/a (0)
  ordered              2   100.0%    50.0%   66.7%     n/a (0)   ← s7: BIRD passes wrong-order, EX+ fails
  set                  1   100.0%   100.0%    0.0%     n/a (0)
  text-numeric         1     0.0%   100.0%    0.0%     n/a (0)   ← s5: BIRD fails the cast, EX+ passes
```

Credentials/ports come from env or the compose file; nothing is hardcoded.
