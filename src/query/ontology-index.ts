/**
 * Ontology loader (pure): turn the generated `OntologyJsonLd` semantic layer into
 * fast in-memory lookups for query compilation — classes, columns, capabilities,
 * and the joinable relationship edges.
 *
 * The join edges are the payoff: each unary object property carries its literal
 * join keys (`qsl:joinFromColumn` / `qsl:joinToColumn`), so JOINs are derived from
 * the ontology, never guessed. N:M aggregate object properties (no literal keys)
 * are skipped here — the junction class is already connected by its two unary FK
 * edges.
 */
import type { OntologyJsonLd } from '../types/ontology.js';
import { JoinEdgeSchema, type JoinEdge } from '../types/query-plan.js';

export interface ClassInfo {
  table: string;
  iri: string;
  prefLabel: string;
  altLabel: string[];
  comment: string;
}
export interface ColumnInfo {
  column: string;
  prefLabel: string;
  /** Synonyms for schema linking (skos:altLabel). Empty when none declared. */
  altLabel: string[];
  comment: string;
  // Query metadata (Sprint 1) — present when the ontology carries it.
  dataType?: string;
  isNumericText?: boolean;
  isPrimaryKey?: boolean;
  isUnique?: boolean;
  sampleValues?: string[];
}
export interface CapabilityInfo {
  kind: string;
  scopeTable: string;
  scopeColumn?: string;
  formulaHint?: string;
  unit?: string;
  prefLabel?: string;
  /** Synonyms for schema linking (skos:altLabel). Empty when none declared. */
  altLabel: string[];
  /** For a metric: whether a larger value is the better/more-extreme one (ranking polarity). */
  preferredDirection?: 'higher' | 'lower';
}
export interface OntologyIndex {
  classes: Map<string, ClassInfo>;
  columnsByTable: Map<string, ColumnInfo[]>;
  capabilities: CapabilityInfo[];
  joinEdges: JoinEdge[];
}

/** Last path segment of a class IRI, e.g. "qsl:class/orders" -> "orders". */
export const tableOfClassIri = (iri: string): string => {
  const parts = iri.split('/');
  return parts[parts.length - 1] ?? iri;
};

export function buildOntologyIndex(ontology: OntologyJsonLd): OntologyIndex {
  const classes = new Map<string, ClassInfo>();
  const columnsByTable = new Map<string, ColumnInfo[]>();
  const capabilities: CapabilityInfo[] = [];
  const joinEdges: JoinEdge[] = [];

  for (const n of ontology['@graph']) {
    switch (n['@type']) {
      case 'owl:Class': {
        const table = n['qsl:mapsToTable'];
        classes.set(table, {
          table,
          iri: n['@id'],
          prefLabel: n['skos:prefLabel'],
          altLabel: n['skos:altLabel'] ?? [],
          comment: n['rdfs:comment'],
        });
        break;
      }
      case 'owl:DatatypeProperty': {
        const table = n['qsl:mapsToTable'];
        const list = columnsByTable.get(table) ?? [];
        list.push({
          column: n['qsl:mapsToColumn'],
          prefLabel: n['skos:prefLabel'],
          altLabel: n['skos:altLabel'] ?? [],
          comment: n['rdfs:comment'],
          ...(n['qsl:dataType'] !== undefined ? { dataType: n['qsl:dataType'] } : {}),
          ...(n['qsl:isNumericText'] !== undefined ? { isNumericText: n['qsl:isNumericText'] } : {}),
          ...(n['qsl:isPrimaryKey'] !== undefined ? { isPrimaryKey: n['qsl:isPrimaryKey'] } : {}),
          ...(n['qsl:isUnique'] !== undefined ? { isUnique: n['qsl:isUnique'] } : {}),
          ...(n['qsl:sampleValues'] !== undefined ? { sampleValues: n['qsl:sampleValues'] } : {}),
        });
        columnsByTable.set(table, list);
        break;
      }
      case 'owl:ObjectProperty': {
        const fromColumn = n['qsl:joinFromColumn'];
        const toColumn = n['qsl:joinToColumn'];
        if (!fromColumn || !toColumn) break; // N:M aggregate — no literal keys; skip for path-finding
        joinEdges.push(
          JoinEdgeSchema.parse({
            fromTable: tableOfClassIri(n['rdfs:domain']['@id']),
            fromColumn,
            toTable: tableOfClassIri(n['rdfs:range']['@id']),
            toColumn,
            cardinality: n['qsl:cardinality'],
            confidence: n['qsl:confidence'],
            provenance: n['qsl:provenance'],
          }),
        );
        break;
      }
      case 'qsl:Capability': {
        capabilities.push({
          kind: n['qsl:kind'],
          scopeTable: tableOfClassIri(n['qsl:scopeClass']),
          scopeColumn: n['qsl:scopeProperty'],
          formulaHint: n['qsl:formulaHint'],
          unit: n['qsl:unit'],
          prefLabel: n['skos:prefLabel'],
          altLabel: n['skos:altLabel'] ?? [],
          ...(n['qsl:preferredDirection'] !== undefined ? { preferredDirection: n['qsl:preferredDirection'] } : {}),
        });
        break;
      }
    }
  }

  return { classes, columnsByTable, capabilities, joinEdges };
}
