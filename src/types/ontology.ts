/**
 * Ontology types: the internal "candidate" shapes the pipeline passes between
 * nodes, plus the serialized JSON-LD shapes that node 5 assembles and persists.
 *
 * Design choice: the LLM emits the *internal* candidate shapes (clean, no
 * `@`-prefixed keys). The `@id` / `@type` / IRI prefixing is deterministic glue
 * applied in node 5, never asked of the model.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// IRI scheme (compact IRIs against the `qsl:` prefix declared in @context)
// ---------------------------------------------------------------------------

export const QSL_PREFIX = 'qsl';
export const QSL_BASE = 'https://qwery.dev/semantic-layer/v1/';

export const classIri = (table: string): string => `${QSL_PREFIX}:class/${table}`;
export const datatypePropertyIri = (table: string, column: string): string =>
  `${QSL_PREFIX}:property/${table}/${column}`;
export const objectPropertyIri = (table: string, fkColumn: string): string =>
  `${QSL_PREFIX}:relationship/${table}/${fkColumn}`;
export const capabilityIri = (kind: string, table: string, column?: string): string =>
  `${QSL_PREFIX}:capability/${kind}/${table}${column ? `/${column}` : ''}`;

// ---------------------------------------------------------------------------
// Internal candidate shapes (passed through graph state)
// ---------------------------------------------------------------------------

export const ConceptCandidateSchema = z.object({
  source: z.object({ table: z.string(), column: z.string().optional() }),
  ontologyKind: z.enum(['Class', 'DatatypeProperty', 'ObjectProperty']),
  prefLabel: z.string(),
  altLabel: z.array(z.string()),
  rdfsLabel: z.string(),
  rdfsComment: z.string(),
});
export type ConceptCandidate = z.infer<typeof ConceptCandidateSchema>;

export const RelationshipSchema = z.object({
  kind: z.enum(['objectProperty', 'subClassOf', 'inverseOf']),
  /** Ontology class IRI (domain). */
  source: z.object({ class: z.string() }),
  /** Ontology class IRI (range). */
  target: z.object({ class: z.string() }),
  predicate: z.string(),
  /**
   * Cardinality read **domain(source) side first** — e.g. a fact→dimension FK is
   * `many-to-one`. Derived from the join columns' uniqueness (Fix 4): both unique →
   * `one-to-one`; source non-unique + target unique → `many-to-one`.
   */
  cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']),
  /**
   * How the relationship was established: `declared` (catalog FK constraint),
   * `discovered` (a profiling-verified inclusion dependency), or `inferred-name`
   * (a strong column-name+type match whose IND fell short — a recovered edge).
   */
  provenance: z.enum(['declared', 'discovered', 'inferred-name']).default('declared'),
  /** FK-likelihood in [0,1]: 1.0 for a declared constraint, the FK score for a discovery. */
  confidence: z.number().min(0).max(1).default(1),
  /** Bridge table for an N:M relationship; null for plain/self-reference FKs. */
  junctionTable: z.string().nullable().default(null),
  /** The literal join keys (source/target columns) so SQL JOINs need no guessing; null for N:M. */
  joinColumns: z.object({ from: z.string(), to: z.string() }).nullable().default(null),
  /** Bounded composite (2-column) join keys (Fix 7); absent for unary/N:M relationships. */
  compositeJoin: z
    .object({ fromColumns: z.array(z.string()), toColumns: z.array(z.string()) })
    .optional(),
  derivedFrom: z.object({ table: z.string(), foreignKey: z.string() }),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

export const CapabilitySchema = z.object({
  kind: z.enum(['metric', 'timeGrain', 'factTable', 'dimension']),
  /** scope.class is an ontology class IRI. */
  scope: z.object({ class: z.string(), property: z.string().optional() }),
  prefLabel: z.string().optional(),
  altLabel: z.array(z.string()).optional(),
  formulaHint: z.string().optional(),
  unit: z.string().optional(),
  /** For a metric: whether a larger value is the better/more-extreme one — the domain
   * polarity behind "best/worst/fastest/slowest". Declared by the LLM so ranking
   * direction is ontology data, not a hardcoded keyword guess. */
  preferredDirection: z.enum(['higher', 'lower']).optional(),
  /**
   * Auditable origin: `llm` (inferred), `deterministic-fallback` (safety-net), or
   * `llm-validated` (inferred AND it passed every deterministic check — Fix 9).
   */
  provenance: z.enum(['llm', 'deterministic-fallback', 'llm-validated']).default('llm'),
  /** Which deterministic checks an `llm-validated` capability passed. */
  validationEvidence: z.array(z.string()).optional(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

// ---------------------------------------------------------------------------
// Serialized JSON-LD shapes (assembled in node 5)
// ---------------------------------------------------------------------------

export const JsonLdContextSchema = z
  .object({
    owl: z.literal('http://www.w3.org/2002/07/owl#'),
    rdfs: z.literal('http://www.w3.org/2000/01/rdf-schema#'),
    skos: z.literal('http://www.w3.org/2004/02/skos/core#'),
    qsl: z.string(),
  })
  .passthrough();

const ClassNodeSchema = z.object({
  '@id': z.string(),
  '@type': z.literal('owl:Class'),
  'rdfs:label': z.string(),
  'rdfs:comment': z.string(),
  'skos:prefLabel': z.string(),
  'skos:altLabel': z.array(z.string()).optional(),
  'qsl:mapsToTable': z.string(),
});

const DatatypePropertyNodeSchema = z.object({
  '@id': z.string(),
  '@type': z.literal('owl:DatatypeProperty'),
  'rdfs:domain': z.object({ '@id': z.string() }),
  'rdfs:label': z.string(),
  'rdfs:comment': z.string(),
  'skos:prefLabel': z.string(),
  'skos:altLabel': z.array(z.string()).optional(),
  'qsl:mapsToTable': z.string(),
  'qsl:mapsToColumn': z.string(),
  // Query metadata (Sprint 1) — optional/additive so older ontologies still parse.
  'qsl:dataType': z.string().optional(),
  'qsl:isNumericText': z.boolean().optional(),
  'qsl:isPrimaryKey': z.boolean().optional(),
  /** Constraint-backed uniqueness (declared PRIMARY KEY / UNIQUE). */
  'qsl:isUnique': z.boolean().optional(),
  /** Profiling-observed uniqueness — unique in this snapshot, not guaranteed by a constraint. */
  'qsl:observedUnique': z.boolean().optional(),
  'qsl:distinctCount': z.number().int().nonnegative().optional(),
  'qsl:sampleValues': z.array(z.string()).optional(),
  /** A sentinel value (e.g. '-', 'N/A', '') used in the data to mean unknown/missing. */
  'qsl:nullPlaceholder': z.string().optional(),
  /** Grain-type of a measure/state column: `cumulative-snapshot` (monotonic running total,
   *  de-cumulated by the compiler) or `as-of-event-snapshot` (non-monotonic carried-forward state,
   *  e.g. a championship rank — a menu grain distinguisher, never de-cumulated). ADR-015. */
  'qsl:temporality': z.enum(['cumulative-snapshot', 'as-of-event-snapshot']).optional(),
  /** Structured evidence for the temporality tag: partition (entity+season) columns, the sequence
   *  order column, the detection signal, and a signal-specific metric (monotonic `ratio` or
   *  carry-forward `vnRatio`). */
  'qsl:temporalityEvidence': z
    .object({
      partitionColumns: z.array(z.string()),
      orderColumn: z.string(),
      signal: z.enum(['monotonic', 'carry-forward']).optional(),
      ratio: z.number().optional(),
      vnRatio: z.number().optional(),
    })
    .optional(),
});

const ObjectPropertyNodeSchema = z.object({
  '@id': z.string(),
  '@type': z.literal('owl:ObjectProperty'),
  'rdfs:domain': z.object({ '@id': z.string() }),
  'rdfs:range': z.object({ '@id': z.string() }),
  'rdfs:label': z.string(),
  /** Omitted on low-confidence edges (Fix 4) — absent metadata beats wrong metadata. */
  'qsl:cardinality': z.string().optional(),
  'qsl:provenance': z.enum(['declared', 'discovered', 'inferred-name']),
  'qsl:confidence': z.number().min(0).max(1),
  'qsl:junctionTable': z.string().optional(),
  'qsl:joinFromColumn': z.string().optional(),
  'qsl:joinToColumn': z.string().optional(),
  /** Composite (multi-column) join keys (Fix 7) — present together with the marker. */
  'qsl:compositeJoin': z.boolean().optional(),
  'qsl:joinFromColumns': z.array(z.string()).optional(),
  'qsl:joinToColumns': z.array(z.string()).optional(),
});

const CapabilityNodeSchema = z.object({
  '@id': z.string(),
  '@type': z.literal('qsl:Capability'),
  'qsl:kind': z.enum(['metric', 'timeGrain', 'factTable', 'dimension']),
  'qsl:scopeClass': z.string(),
  'qsl:scopeProperty': z.string().optional(),
  'skos:prefLabel': z.string().optional(),
  'skos:altLabel': z.array(z.string()).optional(),
  'qsl:formulaHint': z.string().optional(),
  'qsl:unit': z.string().optional(),
  'qsl:preferredDirection': z.enum(['higher', 'lower']).optional(),
  'qsl:provenance': z.enum(['llm', 'deterministic-fallback', 'llm-validated']),
  'qsl:validationEvidence': z.array(z.string()).optional(),
});

export const GraphNodeSchema = z.discriminatedUnion('@type', [
  ClassNodeSchema,
  DatatypePropertyNodeSchema,
  ObjectPropertyNodeSchema,
  CapabilityNodeSchema,
]);
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const OntologyJsonLdSchema = z.object({
  '@context': JsonLdContextSchema,
  '@graph': z.array(GraphNodeSchema),
});
export type OntologyJsonLd = z.infer<typeof OntologyJsonLdSchema>;

// ---------------------------------------------------------------------------
// Export tiering (Fix 5) + ontology header (Fix 6)
// ---------------------------------------------------------------------------

/**
 * A low-confidence discovered relationship, published OUTSIDE the asserted graph and
 * NOT typed `owl:ObjectProperty`, so consumers never auto-join on value-overlap noise.
 * Same shape as an object property otherwise (all evidence fields kept).
 */
export const CandidateRelationshipNodeSchema = ObjectPropertyNodeSchema.extend({
  '@type': z.literal('qsl:CandidateRelationship'),
});
export type CandidateRelationshipNode = z.infer<typeof CandidateRelationshipNodeSchema>;

/** The `owl:Ontology` header: provenance + reproducibility metadata for one build. */
export const OntologyHeaderNodeSchema = z.object({
  '@id': z.string(),
  '@type': z.literal('owl:Ontology'),
  'rdfs:label': z.string().optional(),
  'owl:versionInfo': z.string(),
  'dcterms:created': z.string(),
  /** Stable hash of DSN host+db+schema list — never credentials. */
  'qsl:sourceFingerprint': z.string(),
  /** Serialized `ONTOLOGY_*` knob values used for the run (threshold reproducibility). */
  'qsl:knobs': z.string().optional(),
});
export type OntologyHeaderNode = z.infer<typeof OntologyHeaderNodeSchema>;

/**
 * The published dataset: an asserted default graph + an optional candidate graph + an
 * optional header, all keyed so the on-disk JSON-LD round-trips. The query layer loads
 * the *full* graph (asserted ∪ candidates re-typed) via `loadFullGraph`.
 */
export const OntologyDatasetSchema = z.object({
  '@context': JsonLdContextSchema,
  'qsl:ontology': OntologyHeaderNodeSchema.optional(),
  '@graph': z.array(GraphNodeSchema),
  'qsl:candidateGraph': z.array(CandidateRelationshipNodeSchema).optional(),
});
export type OntologyDataset = z.infer<typeof OntologyDatasetSchema>;

// ---------------------------------------------------------------------------
// Validation errors (collected, not thrown, by node 5)
// ---------------------------------------------------------------------------

export const ValidationErrorSchema = z.object({
  rule: z.enum([
    'object-property-domain-range',
    'metric-formula-columns',
    'skos-preflabel-unique',
    'orphan-class',
    // Fix 1 — a comment cited an example value not present in the column's samples.
    'comment-cites-known-values',
    // Fix 2 — formulaHint failed parse / bind / dry-run / type checks.
    'formula-parse',
    'formula-bind',
    'formula-dry-run',
    'formula-type',
    // Fix 3 — SUM over a cumulative-snapshot measure (deterministic backstop).
    'cumulative-no-sum',
  ]),
  message: z.string(),
  /** @id or label of the offending node. */
  subject: z.string(),
  /**
   * Which node should fix this on retry: `concept` (node 2, structural/labels/comments)
   * or `capability` (node 4, metric formulas). Drives the ⑤→② vs ⑤→④ retry routing.
   * Absent → treated as `concept`.
   */
  origin: z.enum(['concept', 'capability']).optional(),
});
export type ValidationError = z.infer<typeof ValidationErrorSchema>;
