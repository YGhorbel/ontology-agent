/**
 * Stage 2 — JSON-LD ontology -> routable OntologyGraph.
 *
 * Parses ONLY the asserted `@graph`. It NEVER reads `qsl:candidateGraph` (RULE A,
 * no-leakage): we reuse `OntologyJsonLdSchema`, which keeps only `@context` + `@graph`
 * and discards the candidate region and the header outright. Contrast with
 * `loadFullGraph` in ontology-index.ts, which deliberately MERGES the candidate graph
 * back in for schema-linking — exactly what Stage 2 must not do.
 *
 * Weight = max(1 - confidence, tier floor)  (RULE C — the H1 knob), or 1 in uniform mode.
 * Junction (`nm__`) edges are dropped (RULE A); a composite FK is ONE edge with >=2
 * column pairs (RULE B).
 */
import { OntologyJsonLdSchema } from '../types/ontology.js';
import type { CapabilityRef, ClassNode, ColumnProp, JoinEdge, OntologyGraph } from './graph-model.js';

/** Last path segment of a class IRI, e.g. "qsl:class/orders" -> "orders" (mirrors ontology-index). */
export const tableOfClassIri = (iri: string): string => {
  const parts = iri.split('/');
  return parts[parts.length - 1] ?? iri;
};

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};

/** Resolved, env-overridable knobs (read once per build). */
export interface GraphKnobs {
  exportMinConf: number;
  floorDeclared: number;
  floorDiscovered: number;
  floorName: number;
}

export function resolveKnobs(): GraphKnobs {
  return {
    exportMinConf: num('QUERY_EXPORT_MIN_CONF', 0.5),
    floorDeclared: 0,
    floorDiscovered: num('QUERY_EDGE_FLOOR_DISCOVERED', 0.02),
    floorName: num('QUERY_EDGE_FLOOR_NAME', 0.3),
  };
}

const tierFloor = (prov: JoinEdge['provenance'], k: GraphKnobs): number =>
  prov === 'declared' ? k.floorDeclared : prov === 'discovered' ? k.floorDiscovered : k.floorName;

/** weight = uniform ? 1 : max(1 - confidence, tier floor). RULE C. */
export function edgeWeight(
  confidence: number,
  prov: JoinEdge['provenance'],
  uniform: boolean,
  k: GraphKnobs,
): number {
  if (uniform) return 1;
  return Math.max(1 - confidence, tierFloor(prov, k));
}

function columnPropOf(n: Record<string, unknown>): ColumnProp {
  const prop: ColumnProp = { col: n['qsl:mapsToColumn'] as string };
  if (n['qsl:dataType'] !== undefined) prop.dataType = n['qsl:dataType'] as string;
  if (n['qsl:isPrimaryKey'] !== undefined) prop.isPrimaryKey = n['qsl:isPrimaryKey'] as boolean;
  if (n['qsl:isUnique'] !== undefined) prop.isUnique = n['qsl:isUnique'] as boolean;
  if (n['qsl:observedUnique'] !== undefined) prop.observedUnique = n['qsl:observedUnique'] as boolean;
  if (n['qsl:temporality'] !== undefined) prop.temporality = n['qsl:temporality'] as string;
  if (n['qsl:sampleValues'] !== undefined) prop.sampleValues = n['qsl:sampleValues'] as string[];
  return prop;
}

export interface BuildOpts {
  uniform?: boolean;
}

/**
 * Build the routable graph from a raw generated ontology dataset (parsed JSON).
 * `raw` may carry `qsl:candidateGraph` / `qsl:ontology` — both are dropped by the schema.
 */
export function buildGraph(raw: unknown, opts: BuildOpts = {}): OntologyGraph {
  const knobs = resolveKnobs();
  const uniform = opts.uniform ?? false;
  // Parsing through OntologyJsonLdSchema keeps ONLY @context + @graph (RULE A enforced structurally).
  const ontology = OntologyJsonLdSchema.parse(raw);

  const nodes = new Map<string, ClassNode>();
  const adjacency = new Map<string, JoinEdge[]>();
  // Columns indexed by table while we stream, attached to nodes at the end.
  const colsByTable = new Map<string, ColumnProp[]>();

  const pushEdge = (key: string, edge: JoinEdge): void => {
    const list = adjacency.get(key);
    if (list) list.push(edge);
    else adjacency.set(key, [edge]);
  };

  for (const n of ontology['@graph']) {
    switch (n['@type']) {
      case 'owl:Class': {
        const iri = n['@id'];
        const table = n['qsl:mapsToTable'] ?? tableOfClassIri(iri);
        nodes.set(iri, { iri, table, properties: [] });
        if (!adjacency.has(iri)) adjacency.set(iri, []);
        break;
      }
      case 'owl:DatatypeProperty': {
        const rec = n as unknown as Record<string, unknown>;
        const table = rec['qsl:mapsToTable'] as string;
        const list = colsByTable.get(table) ?? [];
        list.push(columnPropOf(rec));
        colsByTable.set(table, list);
        break;
      }
      case 'owl:ObjectProperty': {
        const rec = n as unknown as Record<string, unknown>;
        // RULE A: drop junction (`nm__`) edges — the junction class is reachable via its real FKs.
        if (rec['qsl:junctionTable'] !== undefined && rec['qsl:junctionTable'] !== null) break;

        const confidence = rec['qsl:confidence'] as number;
        // Belt-and-suspenders: never route over a low-confidence edge.
        if (confidence < knobs.exportMinConf) break;
        const provenance = rec['qsl:provenance'] as JoinEdge['provenance'];

        const domain = (rec['rdfs:domain'] as { '@id': string })['@id'];
        const range = (rec['rdfs:range'] as { '@id': string })['@id'];
        const sourceIri = rec['@id'] as string;

        // RULE B: a composite FK is ONE edge with >=2 column pairs.
        let columnPairs: { fromCol: string; toCol: string }[];
        const fromCols = rec['qsl:joinFromColumns'] as string[] | undefined;
        const toCols = rec['qsl:joinToColumns'] as string[] | undefined;
        if (rec['qsl:compositeJoin'] === true && fromCols && toCols && fromCols.length >= 2) {
          columnPairs = fromCols.map((f, i) => ({ fromCol: f, toCol: toCols[i]! }));
        } else {
          const fromCol = rec['qsl:joinFromColumn'] as string | undefined;
          const toCol = rec['qsl:joinToColumn'] as string | undefined;
          if (!fromCol || !toCol) break; // no literal keys — not routable
          columnPairs = [{ fromCol, toCol }];
        }

        const weight = edgeWeight(confidence, provenance, uniform, knobs);
        const base = { weight, confidence, provenance, domain, range, sourceIri } as const;
        // Forward copy (domain -> range).
        pushEdge(domain, { ...base, from: domain, to: range, columnPairs });
        // Reverse copy (undirected): swap endpoints AND pair orientation; keep domain/range/sourceIri.
        pushEdge(range, {
          ...base,
          from: range,
          to: domain,
          columnPairs: columnPairs.map((p) => ({ fromCol: p.toCol, toCol: p.fromCol })),
        });
        break;
      }
      // qsl:Capability handled by the subgraph layer (it reads the dataset's capabilities directly).
      default:
        break;
    }
  }

  for (const [table, cols] of colsByTable) {
    // Class IRIs follow qsl:class/<table>; attach by table name.
    for (const node of nodes.values()) {
      if (node.table === table) node.properties = cols;
    }
  }

  return { nodes, adjacency };
}

/**
 * Load capability references from the raw dataset's `@graph`. Kept separate from
 * `buildGraph` because `extractSubgraph` takes capabilities as an explicit argument
 * (Stage 1 may filter them before routing). Reads `@graph` only — never the candidate graph.
 */
export function loadCapabilities(raw: unknown): CapabilityRef[] {
  const ontology = OntologyJsonLdSchema.parse(raw);
  const out: CapabilityRef[] = [];
  for (const n of ontology['@graph']) {
    if (n['@type'] !== 'qsl:Capability') continue;
    const rec = n as unknown as Record<string, unknown>;
    const ref: CapabilityRef = {
      iri: rec['@id'] as string,
      kind: rec['qsl:kind'] as string,
      scopeClass: rec['qsl:scopeClass'] as string,
    };
    if (rec['qsl:scopeProperty'] !== undefined) ref.scopeProperty = rec['qsl:scopeProperty'] as string;
    if (rec['skos:prefLabel'] !== undefined) ref.prefLabel = rec['skos:prefLabel'] as string;
    out.push(ref);
  }
  return out;
}
