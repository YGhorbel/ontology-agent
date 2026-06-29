# Stage 1 — anchoring (question → AnchorSet)

Anchoring is the NL2SQL **front door**: it turns a raw question string into the inputs Stage 2
consumes — a recall-favoring set of candidate **terminals** (class IRIs the answer must touch),
plus the **concept** and **value** anchors that justify them. Code: `src/query/anchor.ts`,
`src/query/anchor-index.ts`, `src/query/anchor-model.ts`.

## Two matchers, unioned

The literature (CHESS, XiYan-SQL, SDE-SQL) does schema linking as two parallel retrievals,
unioned: a **value retriever** (question keywords vs actual DB cell values) and a
**column/concept retriever** (keywords vs column names/descriptions). Both miss what the other
catches — `"average lap time"` is a *concept* hit (a capability), `"British"` is a *value* hit (a
nationality cell) — so every recent system runs both and unions them. We do the same.

```ts
ConceptAnchor { kind: 'class'|'property'|'capability'; iri; matchedText; via; score }
ValueAnchor   { property; class; value; matchedKeyword; score; matchType: 'exact'|'fuzzy' }
AnchorSet     { terminals: string[]; conceptAnchors; valueAnchors; trace }
```

`terminals` is the S1→S2 contract: the class IRIs `extractSubgraph(graph, terminals, …)` routes
over. `trace` carries the extracted keywords, both matchers' candidates pre-union, the union, and
the final terminals — enough to debug a miss.

## Why ours is a static-index lookup, not live-DB LSH

The field needs LSH because it searches the **live database** at query time — millions of rows,
edit-distance + embeddings over them, and column-description similarity. **We do not, because the
generator already pre-computed the profiling.** The qsl ontology carries, statically:

- `qsl:sampleValues` per column — representative extracted values. *This is our value index.*
- `skos:prefLabel` / `skos:altLabel` / `rdfs:comment` per class, property, and capability. *This
  is our concept index.*

So "value-retriever ∪ column-retriever over the live DB" becomes, for us, "fuzzy match over
`sampleValues` ∪ lexical match over ontology label text" — both over a small **in-memory** index
(`buildAnchorIndex`, `src/query/anchor-index.ts`), built from the asserted `@graph` **only**. Our
semantic layer turns query-time retrieval into a static lookup. (The index is built by parsing
through `OntologyJsonLdSchema`, which keeps only `@context` + `@graph` — structurally excluding
`qsl:candidateGraph`, exactly as Stage 2's `buildGraph` does.)

## Lexical-first; embeddings + keyword-LLM deferred behind seams

SING-SQL found dense semantic search substantially slower and adopted BM25 as primary. At our
scale (tens of classes, a few hundred sample values per column) lexical + edit-distance is fast,
deterministic, and dependency-light. Scoring is a **tiered lexical** scheme, NOT BM25 — BM25's
IDF weighting earns its keep ranking across a large corpus, but each "document" here is a 1–4-token
label and the goal is recall + determinism, not fine ranking. The tiers mirror the schema linker's
`nameScore` bands (one consistent threshold set across the repo):

| tier | score |
|------|-------|
| exact phrase (span === surface) | `1.0` |
| token-subset / substring containment | `~0.76–0.9` |
| single-token fuzzy (`similarity ≥ fuzzyThreshold`, default `0.82`) | `min(0.9, sim)` |
| description (`rdfs:comment`) containment, multi-word spans only | `0.72` |
| value exact / fuzzy | `0.95` / `sim` |

Keyword extraction is plain uni/bi/tri-gram **spans** of the tokenized question (no LLM). Two
seams are left explicitly stubbed: `AnchorOpts.rerank` (default identity) is where an embedding
re-ranker would slot in; a few-shot keyword-extraction LLM (CHESS-style) is the documented future
alternative to n-grams. Neither is wired now — we keep tests deterministic and dependency-free.

A lone aggregation **cue** word (`average`, `count`, `total`, …) is framing, not a concept name, so
it anchors only on an *exact* label hit — never as a weak subset of `"average points"`. Multi-word
spans like `"average lap time"` are unaffected. (Same `skippable` discipline the linker uses.)

## Recall-favoring; downstream prunes

Schema linking's dominant failure mode at scale (>60% error) is committing to too narrow a linked
set too early. So Stage 1 **over-returns**: `terminals` = (classes from concept anchors) ∪
(owning/scope classes of property + capability anchors) ∪ (classes of value anchors), ordered by
best contributing score and capped at `maxTerminals` — a **generous bound (default 8), never 1**.
S1 prunes nothing on semantic grounds; it does not pick "the" table or require connectivity.

Final pruning is downstream and already strong:

- **Stage 2 (Steiner)** keeps only the cheapest *connected* subset — extra candidate terminals
  that don't aid connectivity simply never end up on the tree.
- **Stage 3a (the leash, `specializeIrSchema` over `payloadIris`)** rejects any IRI not in the
  payload.

Too few terminals is unrecoverable (Steiner can't route); a few extra are harmlessly filtered. We
bias toward extra. See [docs/adr/005-anchoring.md](../adr/005-anchoring.md).

## Relationship to `schema-linker.ts`

`src/query/schema-linker.ts` also links questions deterministically — but it is **precision-
favoring** and feeds the *older pre-IR path*: it greedily claims tokens (longest-span-first, each
consumed once), commits to **one** best ref per span, and emits a full SQL skeleton (`QueryIntent`)
for `intent-to-sql.ts`. Anchoring is **recall-favoring** and feeds the *new IR path* (Steiner →
LLM planner → compiler). Different bias, different consumer — so anchoring is a separate module
that reuses only the shared `text-normalize.ts` layer (tokenizer, n-gram spans, edit distance),
not `linkQuestion`.

## Handoff to the wiring brick (not done here)

`ValueAnchor` carries the matched **column** (`property`) as well as its class. Deriving
`ExtractOpts.anchoredColumns` from value (and concept-property) anchors at wiring time is what lets
a cumulative column (e.g. `driverstandings.points`) keep its `temporalityEvidence` through Stage 2's
payload trim — i.e. it is **load-bearing for H2**. Stage 1's output is the `AnchorSet` only; the
next brick wires the full pipeline graph and builds `anchoredColumns` from it.

## Superlative grounding (Stage-1.x) — `superlative.ts`

A superlative ("**oldest** driver") expresses a *ranking intent over a dimension* (date of birth).
The ranking OPERATOR is general and already lives in the IR (`orderBy` + `limit`); what was missing
is the **grounding** — binding that operator to the right typed column. Without it, the dimension
column (`drivers.dob`) has no enum samples and no lexical anchor, so the S2 trimmer drops it and the
planner falls back to the only sortable column left (an id). This is the wrong-column bug
[ADR-010](../adr/010-planner-menu-semantics.md) describes from the menu side; **ADR-010 surfaces the
semantics of columns that are present, but it has nothing to show if the column was already trimmed.**
This step ensures the column **survives**.

**The rule (self-scoping, single-candidate).** When the question carries a superlative token and a
candidate class is in play, count that class's **orderable** columns of the superlative's **dimension
type**. *Orderable* = the right SQL type (date/timestamp for a date superlative) **and not id-like**
(`isPrimaryKey` or a name ending in `id` — `driverid` is sortable but is NOT a dimension; this
exclusion is *why* the planner's id guess was wrong). If **exactly one** such column exists → ground
it (emit a `SuperlativeDirective` with the implied direction); if **zero or more than one** → fall
through and ground nothing. Never guess among candidates.

**Lexicon — LANGUAGE, not domain.** A small static map from superlative token → (dimension type,
direction): `oldest`/`earliest` → (date, ASC), `youngest`/`newest`/`latest` → (date, DESC). This is
English, the only "added knowledge", and it is language not domain; the column TYPES come from the
profiling the generator already did — so **H4 (zero curation) is preserved**. The predicate is
**type-parameterized** (`isOrderable(col, type)`): adding numeric superlatives later is "add lexicon
entries + confirm the guard holds for numerics", not a rewrite.

**Promotion without regression.** Grounding does NOT change the prune rule, the trimmer mechanism, or
the `AnchorSet`. It runs in the pipeline's `subgraphNode` (where the graph — and thus
`ColumnProp.dataType`/`isPrimaryKey` — is in scope; `anchorQuestion` is deliberately graph-free) and
**merges its one column into the `anchoredColumns` map** that `trimColumns` already honors. One more
anchored column fed in; everything downstream is unchanged. A question with no superlative token
grounds nothing, so the over-join and happy-path payloads are byte-identical.

**Deferred on purpose** (the AmbiSQL multi-candidate cases): `"first race"` (year vs round vs date —
a cross-type ambiguity), `"most points"` (four points columns + aggregate-then-rank, a separate
IR-composition concern), and `"fastest lap"` (already resolved via the capability path's
`preferredDirection`). See [ADR-011](../adr/011-superlative-grounding.md).
