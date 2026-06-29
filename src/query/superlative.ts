/**
 * Stage-1.x — superlative grounding: bind an unambiguous superlative to the typed orderable
 * column it ranks over, so the EXISTING pruning + S2 trimmer keep that column for the planner.
 *
 * Why this exists: a superlative ("oldest driver") expresses a ranking intent over a DIMENSION
 * (date of birth), but nothing lexically anchors that column — it has no enum samples, so the
 * trimmer drops it and the planner falls back to the only sortable column left (an id). The
 * superlative OPERATOR is general and already lives in the IR (orderBy+limit — GrailQA/ArcaneQA);
 * this module adds only the GROUNDING: schema-linking the operator to a typed column. Unambiguous
 * only in the single-candidate case (AmbiSQL) — so we ground EXACTLY there and defer the rest.
 *
 * Self-scoping rule: a superlative grounds a column iff a candidate class has EXACTLY ONE orderable
 * column of the matching dimension type. ZERO or >1 → fall through (never guess). The lexicon is
 * LANGUAGE (English superlatives), not domain knowledge; the column types come from profiling the
 * generator already did — so H4 (zero curation) is preserved.
 *
 * This runs in the pipeline's subgraphNode (not in anchorQuestion, which is graph-free): the
 * orderable predicate needs ColumnProp.dataType/isPrimaryKey, which live only in the graph. Its
 * grounded columns are merged into the `anchoredColumns` map — the exact seam `trimColumns`
 * already honors, so there is no change to prune/trim/Steiner mechanism.
 *
 * SCOPE (this brick): DATE superlatives only. The predicate is type-parameterized so numeric is a
 * later EXTENSION (add lexicon entries + confirm the single-candidate guard holds for numerics),
 * not a rewrite. Deferred on purpose: "first" (year/round/date ambiguity), numeric superlatives
 * ("most points" = aggregate-then-rank), "fastest" (capability-resolved). See docs/query/anchoring.md
 * and docs/adr/011-superlative-grounding.md.
 */
import { datatypePropertyIri } from '../types/ontology.js';
import { rawTokens } from './text-normalize.js';
import type { ColumnProp, OntologyGraph } from './graph-model.js';
import type { SuperlativeDirective } from './anchor-model.js';

/** Orderable dimension families. Only `date` is wired now; `numeric` is the reserved extension. */
type DimType = 'date' | 'numeric';

interface SuperlativeLex {
  type: DimType;
  /** Ranking direction the token implies: min=ASC (oldest), max=DESC (youngest). */
  dir: 'ASC' | 'DESC';
}

/**
 * Superlative token → (dimension type, ranking direction). DATE-only now (the proven-clean
 * single-candidate case). 'first'/'fastest'/numeric superlatives are DEFERRED — absent on purpose.
 */
const SUPERLATIVES: Record<string, SuperlativeLex> = {
  oldest: { type: 'date', dir: 'ASC' }, // min date = oldest
  earliest: { type: 'date', dir: 'ASC' },
  youngest: { type: 'date', dir: 'DESC' }, // max date = youngest
  newest: { type: 'date', dir: 'DESC' },
  latest: { type: 'date', dir: 'DESC' },
};

/** SQL date/time types that are orderable as a date dimension (case-insensitive; F1 uses `date`). */
const DATE_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'datetime']);

/** A PK or an id-like name is an identifier, never a ranking dimension — this is the driverid trap. */
function isIdLike(c: ColumnProp): boolean {
  return c.isPrimaryKey === true || /id$/i.test(c.col);
}

/**
 * Type-parameterized orderable predicate. To add numeric superlatives later, extend the `numeric`
 * branch (e.g. bigint/real/numeric, excluding id-like) — the rule and the guard are unchanged.
 */
function isOrderable(c: ColumnProp, type: DimType): boolean {
  if (isIdLike(c)) return false;
  const dt = (c.dataType ?? '').toLowerCase();
  if (type === 'date') return DATE_TYPES.has(dt);
  return false; // numeric: reserved for the documented later extension
}

/**
 * Ground each superlative in `question` to the single orderable column of its dimension type on a
 * candidate class. Returns one directive per (class, dimension type) that resolves UNAMBIGUOUSLY.
 *
 * @param question           the raw NL question
 * @param candidateClassIris classes in play (the pruned terminal set — the classes entering the tree)
 * @param graph              the ontology graph (carries ColumnProp.dataType / isPrimaryKey)
 */
export function groundSuperlatives(
  question: string,
  candidateClassIris: string[],
  graph: OntologyGraph,
): SuperlativeDirective[] {
  const toks = new Set(rawTokens(question));
  // Collapse the question's superlatives to one (direction, token) per dimension type. Opposing
  // directions for the same type (e.g. "oldest" AND "youngest") are ambiguous → drop that type.
  const intents = new Map<DimType, { dir: 'ASC' | 'DESC'; token: string }>();
  const conflicted = new Set<DimType>();
  for (const [token, lex] of Object.entries(SUPERLATIVES)) {
    if (!toks.has(token)) continue;
    const prev = intents.get(lex.type);
    if (prev && prev.dir !== lex.dir) conflicted.add(lex.type);
    if (!prev) intents.set(lex.type, { dir: lex.dir, token });
  }
  for (const t of conflicted) intents.delete(t);
  if (intents.size === 0) return [];

  const out: SuperlativeDirective[] = [];
  for (const classIriStr of candidateClassIris) {
    const node = graph.nodes.get(classIriStr);
    if (!node) continue;
    for (const [type, intent] of intents) {
      const orderable = node.properties.filter((c) => isOrderable(c, type));
      if (orderable.length !== 1) continue; // 0 or >1 candidate → fall through (the AmbiSQL guard)
      const col = orderable[0]!.col;
      out.push({
        classIri: classIriStr,
        column: col,
        propertyIri: datatypePropertyIri(node.table, col),
        dir: intent.dir,
        token: intent.token,
        provenance: 'superlative',
      });
    }
  }
  return out;
}
