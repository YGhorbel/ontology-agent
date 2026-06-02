/**
 * The narrow LLM port the agent depends on. Nodes 2 and 4 receive a
 * `StructuredLlm` by dependency injection — they never import a concrete model.
 *
 * This is the seam that makes the whole build key-optional: the real
 * implementation (src/llm/client.ts) wraps a LangChain chat model, while tests
 * inject a deterministic fake that returns canned, schema-valid objects with no
 * network call and no API key.
 */
import type { z } from 'zod';

export interface StructuredLlm {
  /**
   * Ask the model for a value matching `schema`. Implementations MUST return a
   * value that parses against the schema (the real impl uses the provider's
   * structured-output mode; the fake parses canned fixtures).
   */
  generate<T>(schema: z.ZodType<T>, system: string, user: string): Promise<T>;
}

/** A single canned response for the fake LLM, matched by a predicate over the user prompt. */
export interface FakeResponse {
  when: (user: string) => boolean;
  /** Returns a plain object that must parse against the schema passed to generate(). */
  respond: (user: string) => unknown;
}

/**
 * Build a deterministic fake LLM for tests. Responses are tried in order; the
 * first whose `when` matches the user prompt is used. The returned object is
 * validated against the call's zod schema, so a drifting fixture fails fast.
 */
export function makeFakeLlm(responses: FakeResponse[]): StructuredLlm {
  return {
    async generate<T>(schema: z.ZodType<T>, _system: string, user: string): Promise<T> {
      const match = responses.find((r) => r.when(user));
      if (!match) {
        throw new Error(`makeFakeLlm: no canned response matched user prompt:\n${user.slice(0, 200)}`);
      }
      return schema.parse(match.respond(user));
    },
  };
}
