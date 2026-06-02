# Ontology Generator (Sprint 1)

Auto-generates an **OWL + SKOS ontology** (JSON-LD) from a PostgreSQL datasource —
the first agent of a semantic layer that augments [Qwery](https://github.com/Guepard-Corp/qwery-core) (a
natural-language-to-SQL agent). Where Qwery sees only *structural* schema (tables,
columns, types, FKs), this agent captures the **domain** (classes, properties,
relationships), the **business glossary** (SKOS synonyms — `revenue` ≡ `turnover` ≡
`top-line`), and **analytical capabilities** (metrics, time grains, fact tables,
dimensions).

It is a standalone repo for now; integration into Qwery is a later 1-file adapter
spike, so the core is built "Qwery-shaped": typed tool interfaces, zod-validated
I/O, no Qwery-specific assumptions.

## The agent (LangGraph state machine, 5 nodes)

```
START → schema-ingest → concept-extract → relationship-link → capability-infer → validate
                              ▲                                                        │
                              └──────────── retry (retryCount < 2 & errors) ───────────┤
                                                                                    END
```

| # | Node | Kind | Responsibility |
|---|------|------|----------------|
| 1 | `schema-ingest` | deterministic | Read `information_schema`/`pg_description` (READ ONLY) → engine-agnostic `CanonicalSchema` (tables, columns, FKs, ≤5 sample rows, numeric stats). |
| 2 | `concept-extract` | LLM | Per table: OWL class + per-column property, each with SKOS `prefLabel`/`altLabel`. |
| 3 | `relationship-link` | deterministic | Each FK → an `objectProperty` relationship (predicate from the FK column). |
| 4 | `capability-infer` | LLM + fallback | Metrics / time grains / fact tables / dimensions. A deterministic safety net synthesizes the `revenue` metric if the LLM misses it. |
| 5 | `validate` | deterministic | Assemble JSON-LD, run 4 structural rules; on failure (retries left) loop back to node 2 with the errors in context. |

The LLM is reached only through a narrow injected port (`StructuredLlm`), so the
whole pipeline runs deterministically in tests with **no API key**.

## Prerequisites

- Node 20+ and `pnpm`
- Docker (for local PostgreSQL)
- An OpenAI API key — **only** for a live run; tests do not need one.

## Setup

```bash
pnpm install
cp .env.example .env          # fill in OPENAI_API_KEY (+ optional LangSmith keys) for a live run
pnpm db:up                    # PostgreSQL 16: creates `ecommerce` (fixture) + empty `ontology_dev`
```

`pnpm db:up` is `docker compose up -d`. If host port 5432 is busy, set
`PG_HOST_PORT` (e.g. `PG_HOST_PORT=55432 pnpm db:up`) and update the ports in `.env`.
Init scripts only run on a fresh volume — to reload the fixture run `pnpm db:down`
(which is `docker compose down -v`) first.

## Run

```bash
npx tsx src/cli/generate.ts --datasource ecommerce
# or: pnpm generate --datasource ecommerce
```

Outputs:
- **JSON-LD file:** `out/ontology-ecommerce-<timestamp>.jsonld`
- **Turtle file:** `out/ontology-ecommerce-<timestamp>.ttl` (standards-compliant OWL/RDF — loadable in Protégé / WebVOWL / any RDF store)
- **Database:** rows in `ontology_fragment` (one per `@graph` node) + a row in `ontology_run`.

Inspect the fragments:

```sql
SELECT fragment_kind, pref_label, alt_labels
FROM ontology_fragment
WHERE datasource_id = 'ecommerce'
ORDER BY fragment_kind, pref_label;
```

The CLI exits non-zero (status `partial`) if validation never passed; the partial
ontology is still written and persisted for inspection.

### Visualize & export

```bash
pnpm viz:setup     # one-time: install headless Chrome used for rendering
pnpm viz           # newest out/*.jsonld -> .mmd (Mermaid) + .svg (open in browser/VS Code)
pnpm ttl           # newest out/*.jsonld -> .ttl (Turtle); also written by every CLI run
pnpm viz out/<file>.jsonld   # target a specific file (same for ttl)
```

The Turtle output follows OWL 2 / RDFS / SKOS conventions: an `owl:Ontology` header,
`owl:Class` / `owl:DatatypeProperty` / `owl:ObjectProperty` declarations, `@en`-tagged
SKOS labels, and capabilities as `qsl:Capability` individuals with IRI-typed
`rdfs:domain` / `rdfs:range` / `qsl:scopeClass`. It parses cleanly in `rdflib`/Protégé.

## Output schema (JSON-LD)

```jsonc
{
  "@context": {
    "owl":  "http://www.w3.org/2002/07/owl#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "qsl":  "https://qwery.dev/semantic-layer/v1/"
  },
  "@graph": [
    { "@id": "qsl:class/orders", "@type": "owl:Class",
      "rdfs:label": "Order", "skos:prefLabel": "Order",
      "skos:altLabel": ["purchase","sale"], "qsl:mapsToTable": "orders" },
    { "@id": "qsl:property/orders/total_amount", "@type": "owl:DatatypeProperty",
      "rdfs:domain": { "@id": "qsl:class/orders" },
      "skos:prefLabel": "Order Total", "qsl:mapsToColumn": "total_amount" },
    { "@id": "qsl:relationship/orders/orders_customer_id_fkey", "@type": "owl:ObjectProperty",
      "rdfs:domain": { "@id": "qsl:class/orders" },
      "rdfs:range":  { "@id": "qsl:class/customers" },
      "rdfs:label": "customer", "qsl:cardinality": "one-to-many" },
    { "@id": "qsl:capability/metric/orders/revenue", "@type": "qsl:Capability",
      "qsl:kind": "metric", "qsl:scopeClass": "qsl:class/orders",
      "skos:prefLabel": "revenue", "skos:altLabel": ["turnover","top-line"],
      "qsl:formulaHint": "SUM(orders.total_amount) - COALESCE(SUM(refunds.amount), 0)",
      "qsl:unit": "EUR", "qsl:provenance": "deterministic-fallback" }
  ]
}
```

`qsl:provenance` distinguishes LLM-inferred capabilities (`"llm"`) from the
deterministic revenue safety net (`"deterministic-fallback"`).

## Tests

```bash
pnpm test            # unit + graph wiring tests — NO database, NO API key
pnpm db:up           # then, for the end-to-end test:
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ecommerce \
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ontology_dev \
  pnpm test:e2e      # real Postgres introspection + deterministic golden LLM
```

Unit tests mock the LLM (via the `StructuredLlm` port) and the database (via the
`Queryable` port). The e2e test uses real PostgreSQL but the same deterministic
golden LLM, so it is reproducible without an API key.

## LangSmith tracing

Set `LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY` + `LANGSMITH_PROJECT`
(`LANGCHAIN_*` aliases also work). Each of the 5 nodes appears as a named step in
the run tree; a retry shows the looped nodes a second time.

## Sprint-2 hooks (entry points for the Semantic Retriever)

1. **Fragment read API** — `ontology_fragment` (indexed on `datasource_id` and
   `pref_label`) is the queryable store the Retriever reads. Sprint 2 adds a
   `pgvector` embedding column alongside `content_jsonld`.
2. **The JSON-LD `@graph` contract** — `src/types/ontology.ts` (`OntologyJsonLdSchema`,
   `GraphNodeSchema`) is the stable shape the Retriever consumes; SKOS `prefLabel`/
   `altLabel` are the glossary the Retriever matches NL terms against.
3. **The injection seam** — `buildGraph({ llm, connect })` + the `StructuredLlm`
   port let the Retriever reuse the same model/DB wiring (and tests reuse the same
   fakes) without touching node logic.

## Project layout

```
src/agent/        state.ts, graph.ts, assemble.ts, nodes/01..05
src/types/        canonical-schema.ts, ontology.ts (zod is the source of truth)
src/llm/          client.ts (provider-agnostic), structured-llm.ts (port + fake)
src/prompts/      concept-extract.ts, capability-infer.ts
src/storage/      pg.ts, ontology-store.ts, ddl.sql
src/fixtures/     ecommerce.sql
src/cli/          generate.ts
test/             nodes/*.test.ts, graph.test.ts, agent.test.ts (e2e), fixtures.ts
docker/init/      00-create-databases.sql, 10-load-ecommerce.sql
```
