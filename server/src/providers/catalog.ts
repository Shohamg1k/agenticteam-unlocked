import type { ModelDescriptor } from '@agentic/core';
import type { OpenAICompatibleConfig } from './openai-compatible.js';

/**
 * Model catalogues for the OpenAI-compatible providers.
 *
 * Prices are USD per 1M tokens, and every entry is a published list price at
 * the time of writing rather than a guess. They are hard-coded because none of
 * these providers expose pricing through their API, and a fetched-but-wrong
 * price silently misroutes every task. A stale price is visible in the diff of
 * this file; a wrong one computed at runtime is not.
 *
 * Throughput figures are rough observed medians used only to rank on latency.
 *
 * Adding a model is one entry here. Adding a provider is one entry in
 * `PROVIDER_CONFIGS` below.
 */

function model(
  id: string,
  label: string,
  over: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'capabilities' | 'contextWindow' | 'pricing'>,
): ModelDescriptor {
  return {
    id,
    label,
    maxOutputTokens: 16_000,
    throughputTps: 60,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    ...over,
  };
}

const OPENAI_MODELS: ModelDescriptor[] = [
  model('gpt-5.1', 'GPT-5.1', {
    capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'vision', 'tool-use'],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
    throughputTps: 60,
    supportsVision: true,
  }),
  model('gpt-5.1-mini', 'GPT-5.1 mini', {
    capabilities: ['cheap-ok', 'code', 'long-context', 'tool-use'],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 0.25, outputPerMTok: 2, cachedInputPerMTok: 0.025 },
    throughputTps: 120,
    supportsVision: true,
  }),
  model('gpt-4.1-mini', 'GPT-4.1 mini', {
    capabilities: ['cheap-ok', 'code', 'long-context'],
    contextWindow: 1_000_000,
    pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6, cachedInputPerMTok: 0.1 },
    throughputTps: 130,
  }),
];

/**
 * Groq's value is throughput, not depth: the numbers below are why the default
 * policy sends boilerplate here and architecture elsewhere. Free-tier request
 * caps are what the ledger enforces; tokens are not billed.
 */
const GROQ_MODELS: ModelDescriptor[] = [
  model('openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', {
    capabilities: ['cheap-ok', 'code', 'strong-reasoning', 'tool-use'],
    contextWindow: 131_072,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.75 },
    throughputTps: 500,
  }),
  model('llama-3.3-70b-versatile', 'Llama 3.3 70B (Groq)', {
    capabilities: ['cheap-ok', 'code'],
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79 },
    throughputTps: 280,
  }),
];

/**
 * OpenRouter is a gateway, so the catalogue here is a curated shortlist rather
 * than its full several-hundred-model list. A user who wants a model that is
 * not here adds it in Settings; the adapter passes any id through unchanged.
 */
const OPENROUTER_MODELS: ModelDescriptor[] = [
  model('anthropic/claude-sonnet-5', 'Claude Sonnet 5 (OpenRouter)', {
    capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'tool-use'],
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    throughputTps: 80,
  }),
  model('deepseek/deepseek-chat', 'DeepSeek Chat', {
    capabilities: ['cheap-ok', 'code', 'strong-reasoning'],
    contextWindow: 128_000,
    pricing: { inputPerMTok: 0.28, outputPerMTok: 0.42 },
    throughputTps: 60,
  }),
  model('qwen/qwen-2.5-coder-32b-instruct', 'Qwen 2.5 Coder 32B', {
    capabilities: ['cheap-ok', 'code'],
    contextWindow: 128_000,
    pricing: { inputPerMTok: 0.07, outputPerMTok: 0.16 },
    throughputTps: 90,
  }),
  model('meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B', {
    capabilities: ['cheap-ok', 'code'],
    contextWindow: 131_072,
    pricing: { inputPerMTok: 0.12, outputPerMTok: 0.3 },
    throughputTps: 100,
  }),
];

export const PROVIDER_CONFIGS: OpenAICompatibleConfig[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'byok',
    models: OPENAI_MODELS,
    defaultModel: 'gpt-5.1',
    keyHint: 'Add an OpenAI API key in Settings, or set OPENAI_API_KEY',
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'free-cloud',
    baseURL: 'https://api.groq.com/openai/v1',
    models: GROQ_MODELS,
    defaultModel: 'openai/gpt-oss-120b',
    // Groq's free tier caps requests, not tokens. These are the ledger's
    // guardrails; the provider's own 429 is still authoritative.
    limits: { rpm: 30, rpd: 1_000 },
    keyHint: 'Add a Groq API key in Settings (free at console.groq.com), or set GROQ_API_KEY',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'byok',
    baseURL: 'https://openrouter.ai/api/v1',
    models: OPENROUTER_MODELS,
    defaultModel: 'deepseek/deepseek-chat',
    keyHint: 'Add an OpenRouter API key in Settings, or set OPENROUTER_API_KEY',
    headers: {
      'HTTP-Referer': 'https://github.com/Shohamg1k/agenticteam-unlocked',
      'X-Title': 'Agentic Team',
    },
  },
];

/**
 * The generic escape hatch: any OpenAI-compatible endpoint (vLLM, LM Studio,
 * Together, a corporate gateway). The base URL and model list come from user
 * settings, which is why this is a factory rather than a constant.
 */
export function customEndpointConfig(opts: {
  baseURL: string;
  models: { id: string; label?: string; contextWindow?: number }[];
  name?: string;
}): OpenAICompatibleConfig {
  const models = opts.models.map((m) =>
    model(m.id, m.label ?? m.id, {
      capabilities: ['cheap-ok', 'code', 'strong-reasoning'],
      contextWindow: m.contextWindow ?? 32_768,
      // Unknown pricing is reported as free rather than invented. The cost
      // dashboard labels this provider's spend as unmeasured.
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    }),
  );
  return {
    id: 'openai-compatible',
    name: opts.name ?? 'Custom endpoint',
    kind: 'byok',
    baseURL: opts.baseURL,
    models,
    defaultModel: models[0]?.id ?? '',
    keyHint: 'Set the base URL, model list and key for your endpoint in Settings',
    supportsTemperature: true,
  };
}
