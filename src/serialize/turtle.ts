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
import { QSL_BASE, type GraphNode, type OntologyJsonLd } from '../types/ontology.js';

const PREFIXES = `@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
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
  const parts = [
    `${ref(n['@id'])} a owl:DatatypeProperty ;`,
    `    rdfs:domain ${ref(n['rdfs:domain']['@id'])} ;`,
    `    rdfs:label ${langLit(n['rdfs:label'])} ;`,
    `    rdfs:comment ${langLit(n['rdfs:comment'])} ;`,
    `    skos:prefLabel ${langLit(n['skos:prefLabel'])} ;`,
  ];
  if (n['skos:altLabel'] && n['skos:altLabel'].length > 0) parts.push(`    skos:altLabel ${langList(n['skos:altLabel'])} ;`);
  parts.push(`    qsl:mapsToTable ${lit(n['qsl:mapsToTable'])} ;`);
  parts.push(`    qsl:mapsToColumn ${lit(n['qsl:mapsToColumn'])} .`);
  return parts.join('\n');
}

function objectTurtle(n: Extract<GraphNode, { '@type': 'owl:ObjectProperty' }>): string {
  const parts = [
    `${ref(n['@id'])} a owl:ObjectProperty ;`,
    `    rdfs:domain ${ref(n['rdfs:domain']['@id'])} ;`,
    `    rdfs:range ${ref(n['rdfs:range']['@id'])} ;`,
    `    rdfs:label ${langLit(n['rdfs:label'])} ;`,
    `    qsl:cardinality ${lit(n['qsl:cardinality'])} ;`,
    `    qsl:provenance ${lit(n['qsl:provenance'])} ;`,
  ];
  if (n['qsl:junctionTable']) parts.push(`    qsl:junctionTable ${lit(n['qsl:junctionTable'])} ;`);
  parts.push(`    qsl:confidence ${n['qsl:confidence']} .`);
  return parts.join('\n');
}

function capabilityTurtle(n: Extract<GraphNode, { '@type': 'qsl:Capability' }>): string {
  const parts = [`${ref(n['@id'])} a qsl:Capability ;`, `    qsl:kind ${lit(n['qsl:kind'])} ;`, `    qsl:scopeClass ${ref(n['qsl:scopeClass'])} ;`];
  if (n['qsl:scopeProperty']) parts.push(`    qsl:scopeProperty ${lit(n['qsl:scopeProperty'])} ;`);
  if (n['skos:prefLabel']) parts.push(`    skos:prefLabel ${langLit(n['skos:prefLabel'])} ;`);
  if (n['skos:altLabel'] && n['skos:altLabel'].length > 0) parts.push(`    skos:altLabel ${langList(n['skos:altLabel'])} ;`);
  if (n['qsl:formulaHint']) parts.push(`    qsl:formulaHint ${lit(n['qsl:formulaHint'])} ;`);
  if (n['qsl:unit']) parts.push(`    qsl:unit ${lit(n['qsl:unit'])} ;`);
  parts.push(`    qsl:provenance ${lit(n['qsl:provenance'])} .`);
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

export function toTurtle(ontology: OntologyJsonLd, datasourceId: string): string {
  const header = `<${QSL_BASE}> a owl:Ontology ;
    rdfs:label ${langLit(`Semantic layer for datasource "${datasourceId}"`)} ;
    owl:versionInfo "qsl/v1" .`;

  // Declarations for the custom vocabulary used below.
  const vocab = [
    'qsl:Capability a owl:Class .',
    'qsl:scopeClass a owl:ObjectProperty .',
    'qsl:scopeProperty a owl:AnnotationProperty .',
    'qsl:kind a owl:AnnotationProperty .',
    'qsl:formulaHint a owl:AnnotationProperty .',
    'qsl:unit a owl:AnnotationProperty .',
    'qsl:provenance a owl:AnnotationProperty .',
    'qsl:confidence a owl:AnnotationProperty .',
    'qsl:junctionTable a owl:AnnotationProperty .',
    'qsl:cardinality a owl:AnnotationProperty .',
    'qsl:mapsToTable a owl:AnnotationProperty .',
    'qsl:mapsToColumn a owl:AnnotationProperty .',
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
