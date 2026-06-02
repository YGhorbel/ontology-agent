/**
 * Provider-agnostic LLM wrapper.
 *
 * `getChatModel()` returns a LangChain `BaseChatModel`; every provider model
 * subclasses it, so `withStructuredOutput` / `withRetry` / `invoke` are uniform.
 * OpenAI is the default (gpt-4o-mini, temp 0.1). Anthropic / Ollama can be added
 * later by extending the switch — the rest of the agent is unaffected because it
 * only ever sees the `StructuredLlm` port.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import type { z } from 'zod';
import type { StructuredLlm } from './structured-llm.js';

export interface LlmConfig {
  provider?: 'openai' | 'azure';
  model?: string;
  temperature?: number;
}

/**
 * Returns a configured LangChain chat model. Reads env for defaults.
 *
 * - `openai`: needs OPENAI_API_KEY; model from LLM_MODEL (default gpt-4o-mini).
 * - `azure` : reads the standard Azure env vars (AZURE_OPENAI_API_KEY,
 *   AZURE_OPENAI_API_INSTANCE_NAME, AZURE_OPENAI_API_DEPLOYMENT_NAME,
 *   AZURE_OPENAI_API_VERSION). The deployment name IS the model — set it via
 *   AZURE_OPENAI_API_DEPLOYMENT_NAME (or LLM_MODEL as an override).
 */
/** Reasoning models (o-series, gpt-5 family) reject a custom temperature. */
const REASONING_MODEL = /(^o\d)|gpt-5/i;
const isReasoningModel = (name?: string): boolean => !!name && REASONING_MODEL.test(name);

export function getChatModel(cfg: LlmConfig = {}): BaseChatModel {
  const provider = cfg.provider ?? (process.env.LLM_PROVIDER as LlmConfig['provider']) ?? 'openai';
  const temperature = cfg.temperature ?? Number(process.env.LLM_TEMPERATURE ?? '0.1');

  switch (provider) {
    case 'openai': {
      const model = cfg.model ?? process.env.LLM_MODEL ?? 'gpt-4o-mini';
      return new ChatOpenAI({ model, ...(isReasoningModel(model) ? {} : { temperature }) });
    }
    case 'azure': {
      // For Azure the deployment IS the model. Resolve it from an explicit cfg or
      // AZURE_OPENAI_API_DEPLOYMENT_NAME — NOT from LLM_MODEL (that belongs to the
      // OpenAI path and may be a leftover default). When cfg.model isn't given,
      // AzureChatOpenAI reads AZURE_OPENAI_API_DEPLOYMENT_NAME from env itself.
      const deployment = cfg.model ?? process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME;
      return new AzureChatOpenAI({
        ...(cfg.model ? { azureOpenAIApiDeploymentName: cfg.model } : {}),
        // gpt-5 / o-series reject non-default temperature, so omit it for them.
        ...(isReasoningModel(deployment) ? {} : { temperature }),
      });
    }
    default:
      // Anthropic / Ollama swap-in point for later sprints.
      throw new Error(`Unsupported LLM provider: ${String(provider)}`);
  }
}

/**
 * The production `StructuredLlm`: wraps a chat model's structured-output mode and
 * retries transient/parse failures up to 2 times.
 */
export function makeRealLlm(cfg: LlmConfig = {}): StructuredLlm {
  const model = getChatModel(cfg);
  return {
    async generate<T>(schema: z.ZodType<T>, system: string, user: string): Promise<T> {
      // `withStructuredOutput` accepts a zod schema directly on this version.
      const structured = model.withStructuredOutput(schema).withRetry({
        stopAfterAttempt: 2,
      });
      const result: unknown = await structured.invoke([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);
      // Re-validate at the boundary so downstream code has a guaranteed-typed value.
      return schema.parse(result);
    },
  };
}
