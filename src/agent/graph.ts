/**
 * LangGraph wiring for the Ontology Generator.
 *
 * Five nodes in sequence, with one bounded retry edge from `validate` back to
 * `concept-extract`. Built via a factory so the LLM and the DB connector can be
 * injected — production passes real implementations; tests pass deterministic fakes.
 *
 * LangSmith tracing is automatic when LANGSMITH_TRACING / LANGCHAIN_TRACING_V2 is
 * set: each addNode() call appears as a named step in the run tree.
 */
import { StateGraph, START, END } from '@langchain/langgraph';
import { OntologyStateAnnotation, type OntologyState } from './state.js';
import { makePgConnector, type SchemaConnector } from '../storage/pg.js';
import { makeRealLlm } from '../llm/client.js';
import type { StructuredLlm } from '../llm/structured-llm.js';
import { createSchemaIngestNode } from './nodes/01-schema-ingest.js';
import { createConceptExtractNode } from './nodes/02-concept-extract.js';
import { createRelationshipLinkNode } from './nodes/03-relationship-link.js';
import { createCapabilityInferNode } from './nodes/04-capability-infer.js';
import { createValidateNode } from './nodes/05-validate.js';

export interface BuildGraphDeps {
  llm: StructuredLlm;
  /** Connector to the target datasource being introspected. Defaults to real pg. */
  connect?: SchemaConnector;
}

const SCHEMA_INGEST = 'schema-ingest';
const CONCEPT_EXTRACT = 'concept-extract';
const RELATIONSHIP_LINK = 'relationship-link';
const CAPABILITY_INFER = 'capability-infer';
const VALIDATE = 'validate';

/** Route after validation: success or retries-exhausted -> END; otherwise loop back. */
export function routeAfterValidate(state: OntologyState): typeof END | typeof CONCEPT_EXTRACT {
  const errors = state.validationErrors ?? [];
  if (errors.length === 0) return END;
  if (state.retryCount >= 2) return END;
  return CONCEPT_EXTRACT;
}

export function buildGraph(deps: BuildGraphDeps) {
  const connect = deps.connect ?? makePgConnector;
  const graph = new StateGraph(OntologyStateAnnotation)
    .addNode(SCHEMA_INGEST, createSchemaIngestNode(connect))
    .addNode(CONCEPT_EXTRACT, createConceptExtractNode(deps.llm))
    .addNode(RELATIONSHIP_LINK, createRelationshipLinkNode())
    .addNode(CAPABILITY_INFER, createCapabilityInferNode(deps.llm))
    .addNode(VALIDATE, createValidateNode())
    .addEdge(START, SCHEMA_INGEST)
    .addEdge(SCHEMA_INGEST, CONCEPT_EXTRACT)
    .addEdge(CONCEPT_EXTRACT, RELATIONSHIP_LINK)
    .addEdge(RELATIONSHIP_LINK, CAPABILITY_INFER)
    .addEdge(CAPABILITY_INFER, VALIDATE)
    .addConditionalEdges(VALIDATE, routeAfterValidate, [CONCEPT_EXTRACT, END]);
  return graph.compile();
}

/** Convenience for production: build with the real LLM + real pg connector. */
export function buildProductionGraph() {
  return buildGraph({ llm: makeRealLlm() });
}
