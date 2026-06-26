# ADR-011 — Superlative grounding: anchor a superlative to a typed orderable dimension (Stage-1.x)

**Status:** Accepted · **Date:** 2026-06-24 · **Scope:** `src/query/superlative.ts` (new), `src/query/pipeline.ts`, `src/query/anchor-model.ts` · **Relates:** [ADR-005](005-anchoring.md), [ADR-006](006-pipeline-wiring.md), [ADR-007](007-ir-generalization.md), [ADR-008](008-semantic-pruning.md), [ADR-010](010-planner-menu-semantics.md)

## Context
The planner pipeline is anchoring → pruning → Steiner → planner → compiler → execute. A diagnostic on
**"who is the oldest driver"** produced the right query SHAPE (ranking: `orderBy` + `limit`) but bound
the WRONG column — `ORDER BY drivers.driverid ASC` instead of `drivers.dob ASC`.

[ADR-010](010-planner-menu-semantics.md) attacked this from the *menu* side: surface each column's
`prefLabel`/`description` so the planner binds superlatives by MEANING. But ADR-010 can only annotate
columns that are **present** in the payload. The deeper failure is upstream: `dob` has no enum samples
and "oldest" doesn't lexically anchor it, so the S2 trimmer (`trimColumns`) **drops it before the menu
is ever built**; the planner then orders by `driverid` because it is the only sortable column left. So
the wrong-column bug is a **Stage-1 anchoring gap**: a superlative expresses a ranking intent over a
dimension, and nothing anchors the superlative to that dimension's column, so pruning/trimming don't
keep it. ADR-010 surfaces meaning; this ADR guarantees the meaningful column **survives** to be shown.

## Literature
The design is the KGQA / text-to-SQL framing, double-checked against the sources:

- **GrailQA** ("Beyond I.I.D.", `2011.07743`) — logical forms *"optionally containing one function
  selected from counting, **superlatives (argmax, argmin)**, and comparatives"*. The superlative is a
  first-class **OPERATOR** in the query language, not stored domain knowledge. Our IR's existing
  `orderBy`+`limit` IS that operator ([ADR-007](007-ir-generalization.md)); we add only the GROUNDING.
- **ArcaneQA** (`2204.08109`) — `ARGMAX`/`ARGMIN` take *"a set of entities u⊂ℰ and a **numerical
  relation** r∈ℛ"* and are grounded by expansion rules to relations producing comparable values. The
  operator must be bound to a **typed column, resolved by schema linking**, not by rules.
- **AmbiSQL** (`2508.15276`) — a *"fine-grained ambiguity taxonomy ... from both database elements and
  LLM reasoning"*; when multiple columns of the right type compete (the *"oldest = age or registration
  date"* case), it **disambiguates rather than guessing**. This is our single-candidate guard.

**Two honest flags (generalizations/adaptations, not contradictions):**
1. GrailQA/ArcaneQA frame the operator over a **numerical** relation. We extend grounding to **date**
   columns — a faithful generalization to any *totally-ordered / comparable* type ("orderable" = date
   now, numeric later). The papers do not do this; we note it rather than imply they did.
2. AmbiSQL **resolves interactively** (asks the user a multiple-choice question). Our pipeline is
   non-interactive, so we take its *principle* ("never force a guess") but **fall through / defer**
   instead of asking. Same discipline, different mechanism.

## Decision
Add a Stage-1.x grounding step. The **operator is general and already in the IR**; the **grounding is
general schema-linking that is unambiguous only in the single-candidate case** — so we ground exactly
there and defer the rest.

**Rule (self-scoping, single-candidate).** For a superlative token over a candidate class, count the
class's **orderable** columns of the superlative's dimension type. *Orderable* = correct SQL type
(date/timestamp/datetime for a date superlative) **and not id-like** — `isPrimaryKey` OR a name ending
in `id`. The id-exclusion is the crux of the original bug: `driverid` is sortable but is an identifier,
not a dimension. **Exactly one** candidate → ground it; **zero or >1** → fall through. Verified against
the fixture: `drivers` has `dob` as its **sole** date orderable (`driverid` is bigint + PK + ends-in-`id`).

**Lexicon (date-only now; type-parameterized predicate).** `oldest`/`earliest` → (date, ASC),
`youngest`/`newest`/`latest` → (date, DESC). The lexicon is LANGUAGE, not domain; column types come
from profiling the generator already did → **H4 (zero curation) preserved**. The predicate
`isOrderable(col, type)` takes the dimension type as a parameter, so numeric is a later EXTENSION
(add lexicon entries + confirm the guard holds for abundant numeric columns), not a rewrite.

**Placement & promotion-without-regression.** Grounding lives in a new `src/query/superlative.ts`
invoked from the pipeline's `subgraphNode` — **not** in `anchorQuestion`, which is deliberately
graph-free (the `AnchorIndex` carries no `dataType`/`isPrimaryKey`; the orderable predicate needs the
graph). Its grounded column is **merged into the `anchoredColumns` map** that `trimColumns` already
honors ([ADR-006](006-pipeline-wiring.md)). No change to the prune rule, the trimmer mechanism, the
Steiner tie-break, the leash, value-grounding, the IR shape, the compiler, the fixture, or the
generator — just one more anchored column fed in. A question without a superlative token grounds
nothing, so over-join and happy-path payloads are **byte-identical** (the non-regression contract).

The implied direction (`ASC`/`DESC`) is recorded on the `SuperlativeDirective` and the pipeline trace.
We deliberately do **not** push it into the planner menu in this brick — ADR-010 already surfaces
`dob`'s label/description so the planner can choose direction by meaning; a menu direction-annotation
is a documented fast-follow if the planner mis-orders.

## Consequences
- **Positive.** `drivers.dob` survives the trim for "oldest/youngest driver" (proven end-to-end); the
  planner can now bind the semantically-correct ranking column. Mechanism reuse means zero downstream
  change and a byte-identical non-regression guarantee. The rule is self-scoping, so it is safe by
  construction — it only fires where grounding is unambiguous.
- **Deferred (logged).** The AmbiSQL multi-candidate cases: `"first race"` (year/round/date cross-type
  ambiguity — `first` is intentionally absent from the lexicon), `"most points"` (four points columns +
  aggregate-then-rank — a separate IR-composition brick), and numeric superlatives in general.
  `"fastest lap"` is capability-resolved via `preferredDirection` (ADR-007), not handled here.
- **Risk.** The bet that the planner picks the correct direction from ADR-010's surfaced description.
  The brick guarantees the column SURVIVES, not that it is ordered correctly; if direction is wrong,
  the documented fix is surfacing the recorded `dir` hint in the menu.

## Alternatives considered
- **Thread the graph into `anchorQuestion`** so grounding lives "in anchoring" as first imagined.
  Rejected: it changes the Stage-1 contract and the anchor test harness for no benefit — the merge
  point is the pipeline regardless.
- **Synthesize a property `ConceptAnchor`** and let `deriveAnchoredColumns` pick it up. Rejected:
  mutating the `AnchorSet` risks interacting with prune's keyword-df logic; merging directly into
  `anchoredColumns` is the smaller, side-effect-free seam.
- **Include numeric superlatives now.** Rejected for this brick: numeric columns are abundant and
  varied, so "exactly one numeric orderable" rarely fires cleanly and risks grounding a low-value
  column; most numeric superlatives are also the deferred aggregate-then-rank case. Date-only is the
  proven-clean single-candidate case; numeric is a guarded extension, not a ceiling.
