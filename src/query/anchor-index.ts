/**
 * Stage 1 (anchoring) — the static index, built from the ontology's `@graph` ONLY.
 *
 * The field (CHESS, XiYan-SQL, SDE-SQL) does anchoring as value-retriever ∪
 * column-retriever, both over the LIVE database at query time (LSH over millions of
 * rows + similarity over column descriptions). We do NOT, because the generator already
 * pre-computed the profiling: `qsl:sampleValues` per column IS our value index, and the
 * SKOS labels/descriptions per class/property/capability ARE our concept index — both
 * tiny and static. Query-time retrieval collapses to an in-memory lookup.
 *
 * Index source is the asserted `@graph` only: we parse through `OntologyJsonLdSchema`
 * (exactly as `buildGraph` does — it keeps ONLY `@context` + `@graph`), which structurally
 * drops `qsl:candidateGraph` and the `owl:Ontology` header. We do NOT use `loadFullGraph`
 * (which deliberately merges candidates back for schema-linking). The candidate region only
 * ever holds relationships anyway — never classes, sample-valued properties, or capabilities
 * — so anchoring stays clean either way, but parsing `@graph`-only makes that a guarantee.
 *
 * Normalization reuses `text-normalize.ts` (the same layer the schema linker uses):
 * lowercase + diacritic/punctuation strip + stopword drop + light singularization, with
 * edit-distance fuzzy fallback. No new tokenizer, no model dependency.
 */
import { OntologyJsonLdSchema } from '../types/ontology.js';
import { classIri, datatypePropertyIri } from '../types/ontology.js';
import { tableOfClassIri } from './ontology-index.js';
import { normalize, tokenize, isNumericLiteral } from './text-normalize.js';
import type { ConceptAnchor } from './anchor-model.js';

/** One searchable concept surface: a single label/name/description string of one element. */
export interface ConceptEntry {
  kind: ConceptAnchor['kind'];
  /** The element's own IRI (class/property/capability `@id`). */
  iri: string;
  /** The class IRI this entry implies as a terminal: self for a class, owner for a property,
   *  scopeClass for a capability. */
  scopeClassIri: string;
  /** Which surface field this entry came from (drives `ConceptAnchor.via`). */
  via: ConceptAnchor['via'];
  /** Normalized surface phrase (label/name) — empty for description entries. */
  surface: string;
  /** Tokens of the surface (label/name) or of the comment (for `via: 'description'`). */
  tokens: string[];
}

/** One column value mapped to its column + owning class (with original casing preserved). */
export interface ValueEntry {
  propertyIri: string;
  classIri: string;
  originalValue: string;
}

export interface AnchorIndex {
  /** Flat list of concept surfaces; the matcher scans it (tens of classes → cheap). */
  concepts: ConceptEntry[];
  /** Normalized sample value → the columns that carry it (a value can live on >1 column). */
  values: Map<string, ValueEntry[]>;
}

/** Build a label/name concept entry; skipped when the label tokenizes to nothing. */
function labelEntry(
  kind: ConceptAnchor['kind'],
  iri: string,
  scopeClassIri: string,
  via: ConceptAnchor['via'],
  label: string | undefined,
): ConceptEntry | null {
  if (!label) return null;
  const tokens = tokenize(label);
  if (tokens.length === 0) return null;
  return { kind, iri, scopeClassIri, via, surface: tokens.join(' '), tokens };
}

/**
 * Build the static anchor index from a raw generated ontology dataset (parsed JSON).
 * `raw` may carry `qsl:candidateGraph` / `qsl:ontology` — both are dropped by the schema.
 */
export function buildAnchorIndex(raw: unknown): AnchorIndex {
  const ontology = OntologyJsonLdSchema.parse(raw);
  const concepts: ConceptEntry[] = [];
  const values = new Map<string, ValueEntry[]>();

  const pushLabel = (
    kind: ConceptAnchor['kind'],
    iri: string,
    scopeClassIri: string,
    via: ConceptAnchor['via'],
    label: string | undefined,
  ): void => {
    const e = labelEntry(kind, iri, scopeClassIri, via, label);
    if (e) concepts.push(e);
  };
  const pushDescription = (
    kind: ConceptAnchor['kind'],
    iri: string,
    scopeClassIri: string,
    comment: string | undefined,
  ): void => {
    if (!comment) return;
    const tokens = tokenize(comment);
    if (tokens.length === 0) return;
    concepts.push({ kind, iri, scopeClassIri, via: 'description', surface: '', tokens });
  };

  for (const n of ontology['@graph']) {
    switch (n['@type']) {
      case 'owl:Class': {
        const iri = n['@id'];
        const table = n['qsl:mapsToTable'];
        pushLabel('class', iri, iri, 'prefLabel', n['skos:prefLabel']);
        for (const alt of n['skos:altLabel'] ?? []) pushLabel('class', iri, iri, 'altLabel', alt);
        pushLabel('class', iri, iri, 'token', table);
        pushDescription('class', iri, iri, n['rdfs:comment']);
        break;
      }
      case 'owl:DatatypeProperty': {
        const table = n['qsl:mapsToTable'];
        const column = n['qsl:mapsToColumn'];
        const owner = classIri(table);
        const iri = datatypePropertyIri(table, column);
        pushLabel('property', iri, owner, 'prefLabel', n['skos:prefLabel']);
        for (const alt of n['skos:altLabel'] ?? []) pushLabel('property', iri, owner, 'altLabel', alt);
        pushLabel('property', iri, owner, 'token', column);
        pushDescription('property', iri, owner, n['rdfs:comment']);
        // Value index: a column's pre-computed sample values, original casing kept.
        for (const v of n['qsl:sampleValues'] ?? []) {
          const norm = normalize(v);
          // Numeric-only values are excluded (mirrors the linker): bare integers bind by
          // adjacency downstream, not by dictionary match, and would match spuriously.
          if (norm.length === 0 || isNumericLiteral(norm)) continue;
          const entry: ValueEntry = { propertyIri: iri, classIri: owner, originalValue: v };
          const list = values.get(norm) ?? [];
          if (!list.some((e) => e.propertyIri === iri)) list.push(entry);
          values.set(norm, list);
        }
        break;
      }
      case 'qsl:Capability': {
        const iri = n['@id'];
        const scope = n['qsl:scopeClass'];
        pushLabel('capability', iri, scope, 'prefLabel', n['skos:prefLabel']);
        for (const alt of n['skos:altLabel'] ?? []) pushLabel('capability', iri, scope, 'altLabel', alt);
        break;
      }
    }
  }

  return { concepts, values };
}
