/**
 * Serialize the JSON-LD ontology to standards-compliant Turtle (W3C Turtle 1.1).
 *
 * Conventions followed:
 *  - An `owl:Ontology` header for the datasource namespace.
 *  - Tables -> `owl:Class`; columns -> `owl:DatatypeProperty` (with rdfs:domain);
 *    FKs -> `owl:ObjectProperty` (with rdfs:domain + rdfs:range).
 *  - SKOS `prefLabel`/`altLabel` and rdfs `label`/`comment` carry an @en language tag
 *    (natural-language strings); machine values (formulas, table/column names) stay plain.
 *  - Capabilities are individuals of `qsl:Capability`; the qsl: predicates are declared
 *    (`owl:AnnotationProperty` / `owl:ObjectProperty`). `qsl:scopeClass`, domain and range
 *    are emitted as IRI references, not strings. (Class-as-scope is OWL 2 DL punning.)
 */
import {
  QSL_BASE,
  type CandidateRelationshipNode,
  type GraphNode,
  type OntologyDataset,
  type OntologyHeaderNode,
  type OntologyJsonLd,
} from '../types/ontology.js';

const PREFIXES = `@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix qsl:  <${QSL_BASE}> .`;

/** Expand a compact `qsl:...` IRI to a full IRI for use inside <...>. */
const expand = (iri: string): string => (iri.startsWith('qsl:') ? QSL_BASE + iri.slice(4) : iri);
const ref = (iri: string): string => `<${expand(iri)}>`;

/** Escape a Turtle string literal per the Turtle grammar. */
const lit = (s: string): string =>
  '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';

/** Natural-language literal with an @en tag. */
const langLit = (s: string): string => `${lit(s)}@en`;
const langList = (xs: string[]): string => xs.map(langLit).join(', ');
/** Plain (non-language) string-literal list, e.g. machine value samples. */
const plainList = (xs: string[]): string => xs.map(lit).join(', ');

function classTurtle(n: Extract<GraphNode, { '@type': 'owl:Class' }>): string {
  const parts = [
    `${ref(n['@id'])} a owl:Class ;`,
    `    rdfs:label ${langLit(n['rdfs:label'])} ;`,
    `    rdfs:comment ${langLit(n['rdfs:comment'])} ;`,
    `    skos:prefLabel ${langLit(n['skos:prefLabel'])} ;`,
  ];
  if (n['skos:altLabel'] && n['skos:altLabel'].length > 0) parts.push(`    skos:altLabel ${langList(n['skos:altLabel'])} ;`);
  parts.push(`    qsl:mapsToTable ${lit(n['qsl:mapsToTable'])} .`);
  return parts.join('\n');
}

function datatypeTurtle(n: Extract<GraphNode, { '@type': 'owl:DatatypeProperty' }>): string {
  // Collect predicate-object pairs, then terminate the last one with '.'.
  const preds: string[] = [
    `rdfs:domain ${ref(n['rdfs:domain']['@id'])}`,
    `rdfs:label ${langLit(n['rdfs:label'])}`,
    `rdfs:comment ${langLit(n['rdfs:comment'])}`,
    `skos:prefLabel ${langLit(n['skos:prefLabel'])}`,
  ];
  if (n['skos:altLabel'] && n['skos:altLabel'].length > 0) preds.push(`skos:altLabel ${langList(n['skos:altLabel'])}`);
  preds.push(`qsl:mapsToTable ${lit(n['qsl:mapsToTable'])}`);
  preds.push(`qsl:mapsToColumn ${lit(n['qsl:mapsToColumn'])}`);
  // Query metadata (Sprint 1) — booleans/number are typed literals; samples are plain strings.
  if (n['qsl:dataType'] !== undefined) preds.push(`qsl:dataType ${lit(n['qsl:dataType'])}`);
  if (n['qsl:isNumericText']) preds.push('qsl:isNumericText true');
  if (n['qsl:isPrimaryKey']) preds.push('qsl:isPrimaryKey true');
  if (n['qsl:isUnique']) preds.push('qsl:isUnique true');
  if (n['qsl:observedUnique']) preds.push('qsl:observedUnique true');
  if (n['qsl:distinctCount'] !== undefined) preds.push(`qsl:distinctCount ${n['qsl:distinctCount']}`);
  if (n['qsl:sampleValues'] && n['qsl:sampleValues'].length > 0) preds.push(`qsl:sampleValues ${plainList(n['qsl:sampleValues'])}`);
  if (n['qsl:nullPlaceholder'] !== undefined) preds.push(`qsl:nullPlaceholder ${lit(n['qsl:nullPlaceholder'])}`);
  if (n['qsl:temporality'] !== undefined) preds.push(`qsl:temporality ${lit(n['qsl:temporality'])}`);
  // Structured evidence (Part 2b) is serialized to TTL as a single JSON string literal — RDF has
  // no native record; consumers that need the parts JSON.parse this one annotation value.
  if (n['qsl:temporalityEvidence'] !== undefined) preds.push(`qsl:temporalityEvidence ${lit(JSON.stringify(n['qsl:temporalityEvidence']))}`);
  return `${ref(n['@id'])} a owl:DatatypeProperty ;\n    ${preds.join(' ;\n    ')} .`;
}

type RelationshipNode = Extract<GraphNode, { '@type': 'owl:ObjectProperty' }> | CandidateRelationshipNode;

/** Shared body for an object property / candidate relationship; only the rdf:type differs. */
function relationshipTurtle(n: RelationshipNode, typeName: string): string {
  const parts = [
    `${ref(n['@id'])} a ${typeName} ;`,
    `    rdfs:domain ${ref(n['rdfs:domain']['@id'])} ;`,
    `    rdfs:range ${ref(n['rdfs:range']['@id'])} ;`,
    `    rdfs:label ${langLit(n['rdfs:label'])} ;`,
    `    qsl:provenance ${lit(n['qsl:provenance'])} ;`,
  ];
  if (n['qsl:cardinality']) parts.push(`    qsl:cardinality ${lit(n['qsl:cardinality'])} ;`);
  if (n['qsl:junctionTable']) parts.push(`    qsl:junctionTable ${lit(n['qsl:junctionTable'])} ;`);
  if (n['qsl:joinFromColumn']) parts.push(`    qsl:joinFromColumn ${lit(n['qsl:joinFromColumn'])} ;`);
  if (n['qsl:joinToColumn']) parts.push(`    qsl:joinToColumn ${lit(n['qsl:joinToColumn'])} ;`);
  if (n['qsl:compositeJoin']) parts.push('    qsl:compositeJoin true ;');
  if (n['qsl:joinFromColumns'] && n['qsl:joinFromColumns'].length > 0) parts.push(`    qsl:joinFromColumns ${plainList(n['qsl:joinFromColumns'])} ;`);
  if (n['qsl:joinToColumns'] && n['qsl:joinToColumns'].length > 0) parts.push(`    qsl:joinToColumns ${plainList(n['qsl:joinToColumns'])} ;`);
  parts.push(`    qsl:confidence ${n['qsl:confidence']} .`);
  return parts.join('\n');
}

const objectTurtle = (n: Extract<GraphNode, { '@type': 'owl:ObjectProperty' }>): string =>
  relationshipTurtle(n, 'owl:ObjectProperty');

function capabilityTurtle(n: Extract<GraphNode, { '@type': 'qsl:Capability' }>): string {
  const parts = [`${ref(n['@id'])} a qsl:Capability ;`, `    qsl:kind ${lit(n['qsl:kind'])} ;`, `    qsl:scopeClass ${ref(n['qsl:scopeClass'])} ;`];
  if (n['qsl:scopeProperty']) parts.push(`    qsl:scopeProperty ${lit(n['qsl:scopeProperty'])} ;`);
  if (n['skos:prefLabel']) parts.push(`    skos:prefLabel ${langLit(n['skos:prefLabel'])} ;`);
  if (n['skos:altLabel'] && n['skos:altLabel'].length > 0) parts.push(`    skos:altLabel ${langList(n['skos:altLabel'])} ;`);
  if (n['qsl:formulaHint']) parts.push(`    qsl:formulaHint ${lit(n['qsl:formulaHint'])} ;`);
  if (n['qsl:unit']) parts.push(`    qsl:unit ${lit(n['qsl:unit'])} ;`);
  if (n['qsl:preferredDirection']) parts.push(`    qsl:preferredDirection ${lit(n['qsl:preferredDirection'])} ;`);
  if (n['qsl:validationEvidence'] && n['qsl:validationEvidence'].length > 0) {
    parts.push(`    qsl:provenance ${lit(n['qsl:provenance'])} ;`);
    parts.push(`    qsl:validationEvidence ${plainList(n['qsl:validationEvidence'])} .`);
  } else {
    parts.push(`    qsl:provenance ${lit(n['qsl:provenance'])} .`);
  }
  return parts.join('\n');
}

function nodeTurtle(n: GraphNode): string {
  switch (n['@type']) {
    case 'owl:Class':
      return classTurtle(n);
    case 'owl:DatatypeProperty':
      return datatypeTurtle(n);
    case 'owl:ObjectProperty':
      return objectTurtle(n);
    case 'qsl:Capability':
      return capabilityTurtle(n);
  }
}

/** Render the Fix 6 `owl:Ontology` header node, or a minimal default when absent. */
function headerTurtle(node: OntologyHeaderNode | undefined, datasourceId: string): string {
  if (!node) {
    return `<${QSL_BASE}> a owl:Ontology ;\n    rdfs:label ${langLit(`Semantic layer for datasource "${datasourceId}"`)} ;\n    owl:versionInfo "qsl/v2" .`;
  }
  const parts = [`${ref(node['@id'])} a owl:Ontology ;`];
  if (node['rdfs:label']) parts.push(`    rdfs:label ${langLit(node['rdfs:label'])} ;`);
  parts.push(`    owl:versionInfo ${lit(node['owl:versionInfo'])} ;`);
  parts.push(`    dcterms:created ${lit(node['dcterms:created'])} ;`);
  if (node['qsl:knobs']) parts.push(`    qsl:knobs ${lit(node['qsl:knobs'])} ;`);
  parts.push(`    qsl:sourceFingerprint ${lit(node['qsl:sourceFingerprint'])} .`);
  return parts.join('\n');
}

const candidateTurtle = (n: CandidateRelationshipNode): string => relationshipTurtle(n, 'qsl:CandidateRelationship');

/**
 * Serialize a tiered dataset to TriG (Fix 5): the asserted graph as the default graph,
 * the candidate relationships in a named `qsl:candidates` graph. The header + vocabulary
 * sit outside any named graph.
 */
export function toTrig(dataset: OntologyDataset, datasourceId: string): string {
  const asserted = toTurtle({ '@context': dataset['@context'], '@graph': dataset['@graph'] }, datasourceId, dataset['qsl:ontology']);
  const candidates = dataset['qsl:candidateGraph'] ?? [];
  if (candidates.length === 0) return asserted;
  const block = candidates.map(candidateTurtle).join('\n\n');
  return `${asserted}\n# --- Candidate relationships (low-confidence; not owl:ObjectProperty) ---\nqsl:candidates {\n${block}\n}\n`;
}

export function toTurtle(ontology: OntologyJsonLd, datasourceId: string, headerNode?: OntologyHeaderNode): string {
  const header = headerTurtle(headerNode, datasourceId);

  // Declarations for the custom vocabulary used below.
  const vocab = [
    'qsl:Capability a owl:Class .',
    'qsl:scopeClass a owl:ObjectProperty .',
    'qsl:scopeProperty a owl:AnnotationProperty .',
    'qsl:kind a owl:AnnotationProperty .',
    'qsl:formulaHint a owl:AnnotationProperty .',
    'qsl:unit a owl:AnnotationProperty .',
    'qsl:preferredDirection a owl:AnnotationProperty .',
    'qsl:provenance a owl:AnnotationProperty .',
    'qsl:confidence a owl:AnnotationProperty .',
    'qsl:junctionTable a owl:AnnotationProperty .',
    'qsl:joinFromColumn a owl:AnnotationProperty .',
    'qsl:joinToColumn a owl:AnnotationProperty .',
    'qsl:compositeJoin a owl:AnnotationProperty .',
    'qsl:joinFromColumns a owl:AnnotationProperty .',
    'qsl:joinToColumns a owl:AnnotationProperty .',
    'qsl:cardinality a owl:AnnotationProperty .',
    'qsl:mapsToTable a owl:AnnotationProperty .',
    'qsl:mapsToColumn a owl:AnnotationProperty .',
    'qsl:dataType a owl:AnnotationProperty .',
    'qsl:isNumericText a owl:AnnotationProperty .',
    'qsl:isPrimaryKey a owl:AnnotationProperty .',
    'qsl:isUnique a owl:AnnotationProperty .',
    'qsl:distinctCount a owl:AnnotationProperty .',
    'qsl:sampleValues a owl:AnnotationProperty .',
    'qsl:nullPlaceholder a owl:AnnotationProperty .',
    'qsl:temporality a owl:AnnotationProperty .',
    'qsl:temporalityEvidence a owl:AnnotationProperty .',
    'qsl:observedUnique a owl:AnnotationProperty .',
    'qsl:CandidateRelationship a owl:Class .',
    'qsl:sourceFingerprint a owl:AnnotationProperty .',
    'qsl:knobs a owl:AnnotationProperty .',
    'qsl:validationEvidence a owl:AnnotationProperty .',
  ].join('\n');

  const order: GraphNode['@type'][] = ['owl:Class', 'owl:DatatypeProperty', 'owl:ObjectProperty', 'qsl:Capability'];
  const sections = order.map((t) =>
    ontology['@graph']
      .filter((n) => n['@type'] === t)
      .map(nodeTurtle)
      .join('\n\n'),
  );

  return [PREFIXES, '', header, '', '# --- Vocabulary ---', vocab, '', '# --- Classes ---', sections[0], '', '# --- Datatype properties ---', sections[1], '', '# --- Relationships ---', sections[2], '', '# --- Capabilities ---', sections[3], ''].join('\n');
}
