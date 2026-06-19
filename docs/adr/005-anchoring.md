# ADR-005 — Stage 1 anchoring (question → terminals + value/concept anchors)

**Status:** Accepted · **Date:** 2026-06-18 · **Scope:** `src/query/{anchor-model,anchor-index,anchor}.ts` · **Relates:** [ADR-002](002-subgraph-extraction.md)

## Context
Stage 1 is the NL2SQL front door: it turns a raw question into what Stage 2's `extractSubgraph`
consumes — a set of candidate **terminal** class IRIs — plus the anchors that justify them. Until
now tests hand-built terminals. Four decisions define how S1 produces them; the literature settles
the first two, the third is the load-bearing one, and the fourth is the architectural note.

## Decision 1 — hybrid + union, not either matcher alone
Run BOTH a **concept matcher** (question n-grams vs class/property/capability labels, names,
descriptions) and a **value matcher** (n-grams vs column `qsl:sampleValues`), and UNION the
results. Concept hits (`"average lap time"` → a capability) and value hits (`"British"` → a
nationality cell) are different kinds of evidence; each misses what the other catches. Every recent
system (CHESS, XiYan-SQL, SDE-SQL) unions them. → `anchorQuestion` emits `conceptAnchors` and
`valueAnchors`; terminals are the union of the classes both imply.

## Decision 2 — lexical/BM25-first; embeddings + keyword-LLM deferred behind seams
SING-SQL found dense semantic search substantially slower and adopted BM25 as primary for
efficiency. At our scale (tens of classes, a few hundred sample values/column) lexical + edit-
distance is fast, deterministic, and dependency-light. We use a **tiered lexical** scheme rather
than BM25 itself: BM25's IDF weighting matters for ranking across a large corpus, but each
"document" here is a 1–4-token label and the goal is recall + determinism, not fine ranking — so a
transparent tier (exact > subset/substring > single-token fuzzy ≥ 0.82 > description containment),
reusing the schema linker's existing `nameScore` thresholds, is simpler and debuggable. Keyword
extraction is plain n-gram spans. Two seams are left stubbed and unwired: `AnchorOpts.rerank`
(default identity — the embedding re-ranker slot) and a future few-shot keyword-extraction LLM.
**No model dependency, no nondeterminism in tests.**

## Decision 3 — recall-favoring, prune-downstream
Schema linking's dominant failure mode at scale (>60% error) is committing to too narrow a linked
set too early. So S1 **over-returns**: terminals are capped at `maxTerminals` — a generous bound
(**default 8, never 1**) — ordered by best contributing score, and S1 prunes nothing on semantic
grounds (no "pick the table", no connectivity requirement). This is safe *only because downstream
pruning is already strong*: Stage 2's Steiner keeps only the cheapest **connected** subset (extra
terminals that don't aid connectivity never join the tree), and Stage 3a's leash
(`specializeIrSchema` over `payloadIris`) rejects out-of-payload IRIs. Too few terminals is
unrecoverable; a few extra are harmlessly filtered. We bias toward extra. A lone aggregation cue
(`average`, `count`, …) is exempted from weak subset matches (exact-only) to keep the over-return
honest rather than noisy.

## Decision 4 — static-index lookup, NOT live-DB LSH (the architectural note)
The field needs LSH because it retrieves over the **live database** at query time. We do not,
because the generator already pre-computed the profiling: `qsl:sampleValues` IS the value index and
the SKOS labels/descriptions ARE the concept index — both small and static, built once by
`buildAnchorIndex` from the asserted `@graph` only (parsed through `OntologyJsonLdSchema`, which
structurally drops `qsl:candidateGraph` and the header, exactly as `buildGraph` does). The semantic
layer turns query-time retrieval into an in-memory lookup — a genuine simplification and an
advantage of having an ontology.

### Relationship to `schema-linker.ts` (a deliberate non-reuse)
`schema-linker.ts` already links questions deterministically, but it is **precision-favoring** and
serves the older pre-IR path: greedy token-claiming, one best ref per span, emitting a full SQL
skeleton (`QueryIntent`) for `intent-to-sql.ts`. Anchoring is **recall-favoring** and feeds the new
IR path (Steiner → planner → compiler). Different bias, different consumer — so anchoring is a
separate module reusing only the shared `text-normalize.ts` layer, not `linkQuestion`. Collapsing
the two would force one of them to abandon its bias.

## Consequences
- S1's output is the `AnchorSet` (`terminals` + concept/value anchors + trace) only. It does NOT
  yet emit `ExtractOpts.anchoredColumns`; value anchors carry the matched column, so the wiring
  brick derives `anchoredColumns` from them — **load-bearing for H2** (keeping a cumulative
  column's `temporalityEvidence` through the Stage-2 trim). Don't lose this at handoff.
- No recall/precision measurement here — the gold set is deferred, so the real exit gate (anchor
  recall) is measured in a later brick. This brick is build-and-unit-test only.
- The lone-cue exact-only guard is a precision tweak inside a recall-favoring stage; if it ever
  suppresses a real concept it can be relaxed without touching the contract.

## Revisit trigger
Wire the embedding `rerank` seam (or the keyword-LLM extractor) if/when gold-set anchor recall
shows lexical matching missing paraphrased concepts; revisit `maxTerminals` if Steiner cost or
planner-leash rejections show the over-return is too wide in practice.
