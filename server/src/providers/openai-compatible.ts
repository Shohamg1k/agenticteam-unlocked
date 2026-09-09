import OpenAI from 'openai';
import type {
  AgentRunError,
  AgentRunEvent,
  CompletionRequest,
  ModelDescriptor,
  ProviderKind,
  ProviderProbeResult,
} from '@agentic/core';
import { estimateTokens } from '@agentic/core';
import { BaseAdapter, errorMessage, guardStream, isAbortError, retryAfterFrom } from './base.js';
import { getSecret } from '../vault.js';

/**
 * One adapter for every provider that speaks the OpenAI chat-completions
 * protocol: OpenAI itself, Groq, OpenRouter, and any endpoint the user points
 * at with a base URL.
 *
 * They differ in exactly three ways — base URL, model catalogue, and how their
 * free tier is capped — so they are three fields, not three files. This is the
 * ADR-0002 principle applied one level down: the shape that varies becomes
 * configuration, not copied code.
 */

export interface OpenAICompatibleConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL?: string;
  models: ModelDescriptor[];
  defaultModel: string;
  limits?: { rpm?: number; rpd?: number };
  /** Where to get a key, shown when there is none. */
  keyHint: string;
  /** Extra headers the provider wants (OpenRouter attribution, for instance). */
  headers?: Record<string, string>;
  /** Some providers reject `temperature`; opt out per provider. */
  supportsTemperature?: boolean;
}

export class OpenAICompatibleAdapter extends BaseAdapter {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly transport = 'http' as const;

  private client?: OpenAI;
  private account = 'default';
  private readonly config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    super();
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.kind = config.kind;
    this.models = config.models;
    this.defaultModel = config.defaultModel;
    this.limits = config.limits;
  }

  setAccount(account: string): void {
    this.account = account;
    this.client = undefined;
  }

  private getClient(): OpenAI | undefined {
    const apiKey = getSecret(this.id, this.account);
    if (!apiKey) return undefined;
    if (!this.client || this.client.apiKey !== apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: this.config.baseURL,
        maxRetries: 1,
        defaultHeaders: this.config.headers,
      });
    }
    return this.client;
  }

  async probe(): Promise<ProviderProbeResult> {
    const available = Boolean(getSecret(this.id, this.account));
    return {
      available,
      detail: available ? `key configured (${this.account})` : this.config.keyHint,
      models: this.models,
    };
  }

  stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    return guardStream(this, request.runId, () => this.run(request, signal));
  }

  private async *run(request: CompletionRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    const client = this.getClient();
    if (!client) {
      yield {
        type: 'error',
        runId: request.runId,
        error: { kind: 'auth', message: `No ${this.name} API key configured` },
        at: Date.now(),
      };
      return;
    }

    const model = this.modelById(request.model) ?? this.models[0]!;
    yield { type: 'start', runId: request.runId, providerId: this.id, model: model.id, at: Date.now() };
    this.countRequest();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
      ...request.messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
        if (m.role === 'assistant') return { role: 'assistant', content: m.content };
        if (!m.images?.length) return { role: 'user', content: m.content };
        return {
          role: 'user',
          content: [
            ...m.images.map((img) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
            { type: 'text' as const, text: m.content },
          ],
        };
      }),
    ];

    const stream = await client.chat.completions.create(
      {
        model: model.id,
        messages,
        max_completion_tokens: Math.min(request.maxOutputTokens ?? 16_000, model.maxOutputTokens),
        stream: true,
        // Usage is not included in a stream unless it is asked for, and without
        // it every call would be a cost estimate rather than a measurement.
        stream_options: { include_usage: true },
        ...(this.config.supportsTemperature !== false && request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                type: 'function' as const,
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
            }
          : {}),
      },
      { signal },
    );

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInput: number | undefined;
    let finishReason: string | null = null;
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;

      if (delta?.content) {
        text += delta.content;
        yield { type: 'delta', runId: request.runId, text: delta.content };
      }

      // Reasoning models on some providers stream a separate reasoning field.
      const reasoning =
        (delta as { reasoning?: string; reasoning_content?: string } | undefined)?.reasoning ??
        (delta as { reasoning_content?: string } | undefined)?.reasoning_content;
      if (reasoning) yield { type: 'thinking', runId: request.runId, text: reasoning };

      // Tool calls arrive fragmented across chunks and are keyed by index.
      for (const tc of delta?.tool_calls ?? []) {
        const entry = toolCalls.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, name: '', args: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        toolCalls.set(tc.index, entry);
      }

      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
        cachedInput = chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined;
      }
    }

    for (const call of toolCalls.values()) {
      let input: unknown = call.args;
      try {
        input = JSON.parse(call.args);
      } catch {
        // Leave the raw string; the caller decides whether that is usable.
      }
      yield { type: 'tool-call', runId: request.runId, name: call.name, input, callId: call.id };
    }

    // Not every OpenAI-compatible server returns usage. Estimating is better
    // than reporting zero, and `measured: false` says which one this is.
    const measured = inputTokens > 0 || outputTokens > 0;
    if (!measured) {
      inputTokens = estimateTokens(request.system + request.messages.map((m) => m.content).join('\n'));
      outputTokens = estimateTokens(text);
    }

    const usage = this.usageOf(model.id, inputTokens, outputTokens, cachedInput, measured);
    yield { type: 'usage', runId: request.runId, usage };
    yield { type: 'done', runId: request.runId, text, usage, at: Date.now() };

    if (finishReason === 'length') {
      yield {
        type: 'log',
        runId: request.runId,
        level: 'warn',
        text: 'Output hit the token ceiling and was truncated',
      };
    }
  }

  override classifyError(err: unknown): AgentRunError {
    if (isAbortError(err)) return { kind: 'cancelled', message: 'Cancelled' };

    if (err instanceof OpenAI.RateLimitError) {
      return { kind: 'quota', message: errorMessage(err), status: 429, retryAfterMs: retryAfterFrom(err) };
    }
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
      return { kind: 'auth', message: errorMessage(err), status: err.status };
    }
    if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError) {
      // A 400 whose body says "quota" is a billing problem, not a bad request —
      // and the difference decides whether failover helps.
      const message = errorMessage(err);
      if (/quota|billing|credit|insufficient/i.test(message)) {
        return { kind: 'quota', message, status: err.status };
      }
      return { kind: 'invalid-request', message, status: err.status };
    }
    if (err instanceof OpenAI.InternalServerError || err instanceof OpenAI.APIConnectionError) {
      return { kind: 'transient', message: errorMessage(err) };
    }
    return super.classifyError(err);
  }
}
