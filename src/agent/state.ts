/**
 * Shared LangGraph state for the Ontology Generator.
 *
 * The channel value types are the zod-inferred types from the type modules, so
 * the state remains zod-described end-to-end (the zod schemas are the source of
 * truth; the Annotation channels just declare reducers/defaults for LangGraph).
 * All pipeline outputs default to null/[] and use last-write-wins reducers.
 */
import { Annotation } from '@langchain/langgraph';
import type { CanonicalSchema } from '../types/canonical-schema.js';
import type { ForeignKeyCandidate } from '../types/foreign-key-candidate.js';
import type {
  ConceptCandidate,
  Relationship,
  Capability,
  OntologyJsonLd,
  ValidationError,
} from '../types/ontology.js';

export const OntologyStateAnnotation = Annotation.Root({
  // --- inputs (set once at invoke) ---
  datasourceId: Annotation<string>(),
  pgConnectionString: Annotation<string>(),

  // --- pipeline outputs ---
  canonicalSchema: Annotation<CanonicalSchema | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Profiling-discovered FK candidates (undeclared + declared, scored); set by relationship-discover. */
  foreignKeyCandidates: Annotation<ForeignKeyCandidate[] | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  conceptCandidates: Annotation<ConceptCandidate[] | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  relationships: Annotation<Relationship[] | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  capabilities: Annotation<Capability[] | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  ontology: Annotation<OntologyJsonLd | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  validationErrors: Annotation<ValidationError[] | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // --- retry loop control (bounded to 2 retries) ---
  retryCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

export type OntologyState = typeof OntologyStateAnnotation.State;
export type OntologyStateUpdate = typeof OntologyStateAnnotation.Update;
