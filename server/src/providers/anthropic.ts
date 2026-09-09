import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentRunError,
  AgentRunEvent,
  CompletionRequest,
  ModelDescriptor,
  ProviderProbeResult,
} from '@agentic/core';
import { estimateTokens } from '@agentic/core';
import { BaseAdapter, errorMessage, guardStream, isAbortError, retryAfterFrom } from './base.js';
import { getSecret } from '../vault.js';

/**
 * Anthropic Messages API.
 *
 * Notes that matter and are easy to get wrong:
 *
 * - Current models take `thinking: { type: 'adaptive' }`. `budget_tokens` is
 *   REMOVED on Opus 5 / Sonnet 5 and returns a 400. Depth is controlled with
 *   `output_config.effort` instead.
 * - Thinking display defaults to omitted, so the `thinking` blocks arrive with
 *   empty text unless `display: 'summarized'` is asked for. We ask for it,
 *   because the UI shows reasoning while a task runs.
 * - Assistant prefill is removed on these models; response shape is steered
 *   with the system prompt, never a seeded assistant turn.
 * - Streaming is used unconditionally. Long tasks with large `max_tokens` hit
 *   HTTP timeouts otherwise, and streaming is what the UI wants anyway.
 */

/**
 * Model catalogue. Prices are USD per 1M tokens.
 *
 * Hard-coded rather than fetched: the Models API does not return pricing, and
 * a wrong price is worse than a stale one because it silently misroutes. The
 * list is small and its provenance is a dated reference, which is checkable.
 * Last verified 2026-06-24.
 */
const MODELS: ModelDescriptor[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'vision', 'tool-use'],
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5 },
    throughputTps: 45,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    capabilities: ['code', 'strong-reasoning', 'long-context', 'frontend', 'vision', 'tool-use', 'cheap-ok'],
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2 },
    throughputTps: 80,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    capabilities: ['cheap-ok', 'code', 'vision', 'tool-use'],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1 },
    throughputTps: 140,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
  },
];

export class AnthropicAdapter extends BaseAdapter {
  readonly id = 'anthropic';
  readonly name = 'Anthropic API';
  readonly kind = 'byok' as const;
  readonly transport = 'http' as const;

  private client?: Anthropic;
  private account = 'default';

  constructor() {
    super();
    this.models = MODELS;
    this.defaultModel = 'claude-opus-5';
  }

  setAccount(account: string): void {
    this.account = account;
    this.client = undefined;
  }

  private getClient(): Anthropic | undefined {
    const apiKey = getSecret('anthropic', this.account);
    if (!apiKey) return undefined;
    // Rebuild when the key changes so a rotated key takes effect immediately.
    if (!this.client || this.client.apiKey !== apiKey) {
      this.client = new Anthropic({ apiKey, maxRetries: 1 });
    }
    return this.client;
  }

  async probe(): Promise<ProviderProbeResult> {
    const available = Boolean(getSecret('anthropic', this.account));
    return {
      available,
      detail: available
        ? `key configured (${this.account})`
        : 'Add an Anthropic API key in Settings, or set ANTHROPIC_API_KEY',
      models: MODELS,
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
        error: { kind: 'auth', message: 'No Anthropic API key configured' },
        at: Date.now(),
      };
      return;
    }

    const model = this.modelById(request.model) ?? this.models[0]!;
    yield { type: 'start', runId: request.runId, providerId: this.id, model: model.id, at: Date.now() };
    this.countRequest();

    const maxTokens = Math.min(request.maxOutputTokens ?? 32_000, model.maxOutputTokens);
    let text = '';

    // The system prompt is the stable prefix, so it gets the cache breakpoint.
    // Everything volatile — the task brief, prior attempts — is in `messages`
    // and sits after it, which is what makes the cache actually hit.
    const stream = client.messages.stream(
      {
        model: model.id,
        max_tokens: maxTokens,
        system: request.cachePrefix
          ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }]
          : request.system,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.images?.length
            ? [
                ...m.images.map((img) => ({
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: img.mimeType as never, data: img.base64 },
                })),
                { type: 'text' as const, text: m.content },
              ]
            : m.content,
        })),
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as never,
              })),
            }
          : {}),
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          text += event.delta.text;
          yield { type: 'delta', runId: request.runId, text: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          yield { type: 'thinking', runId: request.runId, text: event.delta.thinking };
        }
      }
    }

    const final = await stream.finalMessage();

    for (const block of final.content) {
      if (block.type === 'tool_use') {
        yield {
          type: 'tool-call',
          runId: request.runId,
          name: block.name,
          input: block.input,
          callId: block.id,
        };
      }
    }

    // A refusal is a successful HTTP call with no usable content. Surfacing it
    // as a `done` with empty text would look like a silent failure downstream,
    // so it becomes an explicit, non-retryable error.
    if (final.stop_reason === 'refusal') {
      const detail = final.stop_details as { category?: string; explanation?: string } | null;
      yield {
        type: 'error',
        runId: request.runId,
        error: {
          kind: 'invalid-request',
          message: `Anthropic declined this request${detail?.category ? ` (${detail.category})` : ''}: ${
            detail?.explanation ?? 'no explanation given'
          }`,
        },
        at: Date.now(),
      };
      return;
    }

    const usage = this.usageOf(
      model.id,
      final.usage.input_tokens + (final.usage.cache_creation_input_tokens ?? 0),
      final.usage.output_tokens,
      final.usage.cache_read_input_tokens ?? undefined,
    );
    // `cache_read` tokens are billed but not counted in input_tokens.
    usage.input += final.usage.cache_read_input_tokens ?? 0;

    yield { type: 'usage', runId: request.runId, usage };
    yield { type: 'done', runId: request.runId, text, usage, at: Date.now() };

    if (final.stop_reason === 'max_tokens') {
      // Not an error — the caller's verification gate will catch a truncated
      // file — but the worklog should say why the output stops mid-thought.
      yield {
        type: 'log',
        runId: request.runId,
        level: 'warn',
        text: `Output hit the ${maxTokens}-token ceiling and was truncated`,
      };
    }
  }

  override classifyError(err: unknown): AgentRunError {
    if (isAbortError(err)) return { kind: 'cancelled', message: 'Cancelled' };

    // Typed SDK errors are authoritative; string matching is the fallback.
    if (err instanceof Anthropic.RateLimitError) {
      return { kind: 'quota', message: errorMessage(err), status: 429, retryAfterMs: retryAfterFrom(err) };
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return { kind: 'auth', message: errorMessage(err), status: err.status };
    }
    if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
      return { kind: 'invalid-request', message: errorMessage(err), status: err.status };
    }
    if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
      return { kind: 'transient', message: errorMessage(err) };
    }
    return super.classifyError(err);
  }

  /** Rough pre-flight token count, used by the router before a call. */
  countTokens(text: string): number {
    return estimateTokens(text);
  }
}
