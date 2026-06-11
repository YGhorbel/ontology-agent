/**
 * Deterministic assembly of the JSON-LD ontology from the internal candidate
 * shapes. This is the "glue" that adds `@id` / `@type` / IRI prefixing — never
 * asked of the LLM.
 */
import {
  classIri,
  datatypePropertyIri,
  objectPropertyIri,
  capabilityIri,
  QSL_BASE,
  type Capability,
  type CandidateRelationshipNode,
  type ConceptCandidate,
  type GraphNode,
  type OntologyJsonLd,
  type Relationship,
} from '../types/ontology.js';
import type { ColumnFact } from '../types/column-fact.js';

const JSONLD_CONTEXT = {
  owl: 'http://www.w3.org/2002/07/owl#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dcterms: 'http://purl.org/dc/terms/',
  qsl: QSL_BASE,
} as const;

/** Min confidence for a discovered edge to be published in the asserted graph (Fix 5). */
export const exportMinConfFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_EXPORT_MIN_CONF);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
};

/** Min confidence for an edge's `qsl:cardinality` to be trustworthy enough to emit (Fix 4). */
export const cardinalityMinConfFromEnv = (): number => {
  const raw = Number(process.env.ONTOLOGY_CARDINALITY_MIN_CONF);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
};

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';

/** Last path segment of a class IRI, e.g. "qsl:class/orders" -> "orders". */
const tableTokenOf = (classIriValue: string): string => {
  const parts = classIriValue.split('/');
  return parts[parts.length - 1] ?? classIriValue;
};

function classNode(c: ConceptCandidate): GraphNode {
  return {
    '@id': classIri(c.source.table),
    '@type': 'owl:Class',
    'rdfs:label': c.rdfsLabel,
    'rdfs:comment': c.rdfsComment,
    'skos:prefLabel': c.prefLabel,
    ...(c.altLabel.length > 0 ? { 'skos:altLabel': c.altLabel } : {}),
    'qsl:mapsToTable': c.source.table,
  };
}

function datatypePropertyNode(c: ConceptCandidate, fact: ColumnFact | undefined): GraphNode {
  const column = c.source.column ?? '';
  return {
    '@id': datatypePropertyIri(c.source.table, column),
    '@type': 'owl:DatatypeProperty',
    'rdfs:domain': { '@id': classIri(c.source.table) },
    'rdfs:label': c.rdfsLabel,
    'rdfs:comment': c.rdfsComment,
    'skos:prefLabel': c.prefLabel,
    ...(c.altLabel.length > 0 ? { 'skos:altLabel': c.altLabel } : {}),
    'qsl:mapsToTable': c.source.table,
    'qsl:mapsToColumn': column,
    // Query metadata (Sprint 1): type always; flags/values only when meaningful.
    ...(fact
      ? {
          'qsl:dataType': fact.dataType,
          ...(fact.isNumericText ? { 'qsl:isNumericText': true } : {}),
          ...(fact.isPrimaryKey ? { 'qsl:isPrimaryKey': true } : {}),
          // Fix 6: constraint-backed uniqueness → isUnique; profiling-observed only → observedUnique.
          ...(fact.declaredUnique || fact.isPrimaryKey
            ? { 'qsl:isUnique': true }
            : fact.isUnique
              ? { 'qsl:observedUnique': true }
              : {}),
          ...(fact.distinctCount !== null ? { 'qsl:distinctCount': fact.distinctCount } : {}),
          ...(fact.sampleValues.length > 0 ? { 'qsl:sampleValues': fact.sampleValues } : {}),
          ...(fact.nullPlaceholder !== undefined ? { 'qsl:nullPlaceholder': fact.nullPlaceholder } : {}),
          ...(fact.temporality ? { 'qsl:temporality': fact.temporality } : {}),
          ...(fact.temporalityEvidence ? { 'qsl:temporalityEvidence': fact.temporalityEvidence } : {}),
        }
      : {}),
  };
}

function relationshipNode(r: Relationship): GraphNode {
  return {
    '@id': objectPropertyIri(r.derivedFrom.table, r.derivedFrom.foreignKey),
    '@type': 'owl:ObjectProperty',
    'rdfs:domain': { '@id': r.source.class },
    'rdfs:range': { '@id': r.target.class },
    'rdfs:label': r.predicate,
    // Fix 4: wrong cardinality is worse than absent — omit it on low-confidence edges.
    ...(r.confidence >= cardinalityMinConfFromEnv() ? { 'qsl:cardinality': r.cardinality } : {}),
    'qsl:provenance': r.provenance,
    'qsl:confidence': r.confidence,
    ...(r.junctionTable ? { 'qsl:junctionTable': r.junctionTable } : {}),
    ...(r.joinColumns
      ? { 'qsl:joinFromColumn': r.joinColumns.from, 'qsl:joinToColumn': r.joinColumns.to }
      : {}),
  };
}

function capabilityNode(cap: Capability, index: number, uniqueId: (base: string) => string): GraphNode {
  const table = tableTokenOf(cap.scope.class);
  // Discriminate by the human label first (distinguishes metrics that share a
  // scope column, e.g. "revenue" vs "average order value" on orders.total_amount),
  // then property, then index. uniqueId() guarantees no two capabilities collide.
  const discriminator = cap.prefLabel ?? cap.scope.property ?? String(index);
  return {
    '@id': uniqueId(`${capabilityIri(cap.kind, table)}/${slug(discriminator)}`),
    '@type': 'qsl:Capability',
    'qsl:kind': cap.kind,
    'qsl:scopeClass': cap.scope.class,
    ...(cap.scope.property ? { 'qsl:scopeProperty': cap.scope.property } : {}),
    ...(cap.prefLabel ? { 'skos:prefLabel': cap.prefLabel } : {}),
    ...(cap.altLabel && cap.altLabel.length > 0 ? { 'skos:altLabel': cap.altLabel } : {}),
    ...(cap.formulaHint ? { 'qsl:formulaHint': cap.formulaHint } : {}),
    ...(cap.unit ? { 'qsl:unit': cap.unit } : {}),
    ...(cap.preferredDirection ? { 'qsl:preferredDirection': cap.preferredDirection } : {}),
    'qsl:provenance': cap.provenance,
    ...(cap.validationEvidence && cap.validationEvidence.length > 0 ? { 'qsl:validationEvidence': cap.validationEvidence } : {}),
  };
}

export function assembleOntology(
  concepts: ConceptCandidate[],
  relationships: Relationship[],
  capabilities: Capability[],
  columnFacts: ColumnFact[] = [],
): OntologyJsonLd {
  const factByCol = new Map<string, ColumnFact>();
  for (const f of columnFacts) factByCol.set(`${f.table} ${f.column}`, f);

  const graph: GraphNode[] = [];
  for (const c of concepts) {
    if (c.ontologyKind === 'Class') graph.push(classNode(c));
    else graph.push(datatypePropertyNode(c, factByCol.get(`${c.source.table} ${c.source.column ?? ''}`)));
  }
  for (const r of relationships) graph.push(relationshipNode(r));

  // Ensure capability IRIs are unique even when labels/scopes slugify the same.
  const used = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return id;
  };
  capabilities.forEach((cap, i) => graph.push(capabilityNode(cap, i, uniqueId)));
  return { '@context': JSONLD_CONTEXT, '@graph': dedupeById(graph) };
}

/**
 * Dedupe nodes by `@id` (Fix 5): identical content collapses to one; a true conflict
 * (same `@id`, different content) is a generator bug and throws. Fixes the
 * `races/nm__status` double-emission while never silently merging distinct edges.
 */
export function dedupeById(graph: GraphNode[]): GraphNode[] {
  const byId = new Map<string, GraphNode>();
  for (const n of graph) {
    const prev = byId.get(n['@id']);
    if (!prev) {
      byId.set(n['@id'], n);
      continue;
    }
    if (JSON.stringify(prev) !== JSON.stringify(n)) {
      throw new Error(`assemble: conflicting duplicate @id "${n['@id']}" with differing content`);
    }
  }
  return [...byId.values()];
}

/**
 * Split the full graph into the published asserted graph and the candidate graph (Fix 5).
 * Asserted relationships: provenance `declared`/`inferred-name`, or `discovered` with
 * confidence ≥ `minConf`. Below the bar → re-typed `qsl:CandidateRelationship`, kept out
 * of the asserted graph so external consumers never treat value-overlap noise as a join.
 */
export function partitionDataset(
  ontology: OntologyJsonLd,
  minConf: number = exportMinConfFromEnv(),
): { assertedGraph: GraphNode[]; candidateGraph: CandidateRelationshipNode[] } {
  const assertedGraph: GraphNode[] = [];
  const candidateGraph: CandidateRelationshipNode[] = [];
  for (const n of ontology['@graph']) {
    if (n['@type'] !== 'owl:ObjectProperty') {
      assertedGraph.push(n);
      continue;
    }
    const asserted =
      n['qsl:provenance'] === 'declared' || n['qsl:provenance'] === 'inferred-name' || n['qsl:confidence'] >= minConf;
    if (asserted) assertedGraph.push(n);
    else candidateGraph.push({ ...n, '@type': 'qsl:CandidateRelationship' });
  }
  return { assertedGraph, candidateGraph };
}
