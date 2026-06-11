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
  qsl: QSL_BASE,
} as const;

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
          ...(fact.isUnique ? { 'qsl:isUnique': true } : {}),
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
    'qsl:cardinality': r.cardinality,
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
  return { '@context': JSONLD_CONTEXT, '@graph': graph };
}
