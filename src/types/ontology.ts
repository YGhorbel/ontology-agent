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
  cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-many']),
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
  /** Auditable origin: LLM-inferred vs deterministic safety-net. */
  provenance: z.enum(['llm', 'deterministic-fallback']).default('llm'),
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
  'qsl:isUnique': z.boolean().optional(),
  'qsl:distinctCount': z.number().int().nonnegative().optional(),
  'qsl:sampleValues': z.array(z.string()).optional(),
  /** A sentinel value (e.g. '-', 'N/A', '') used in the data to mean unknown/missing. */
  'qsl:nullPlaceholder': z.string().optional(),
  /** Marks a measure whose values are cumulative running totals (SUM double-counts; use MAX/last-per-group). */
  'qsl:temporality': z.enum(['cumulative-snapshot']).optional(),
  /** String evidence for the temporality tag: partition/order columns + observed monotonic ratio. */
  'qsl:temporalityEvidence': z.string().optional(),
});

const ObjectPropertyNodeSchema = z.object({
  '@id': z.string(),
  '@type': z.literal('owl:ObjectProperty'),
  'rdfs:domain': z.object({ '@id': z.string() }),
  'rdfs:range': z.object({ '@id': z.string() }),
  'rdfs:label': z.string(),
  'qsl:cardinality': z.string(),
  'qsl:provenance': z.enum(['declared', 'discovered', 'inferred-name']),
  'qsl:confidence': z.number().min(0).max(1),
  'qsl:junctionTable': z.string().optional(),
  'qsl:joinFromColumn': z.string().optional(),
  'qsl:joinToColumn': z.string().optional(),
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
  'qsl:provenance': z.enum(['llm', 'deterministic-fallback']),
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
