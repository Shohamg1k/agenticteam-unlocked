import { GoogleGenAI } from '@google/genai';
import type {
  AgentRunError,
  AgentRunEvent,
  CompletionRequest,
  ModelDescriptor,
  ProviderProbeResult,
} from '@agentic/core';
import { estimateTokens } from '@agentic/core';
import { BaseAdapter, errorMessage, guardStream, isAbortError } from './base.js';
import { getSecret } from '../vault.js';

/**
 * Google Gemini.
 *
 * Its role in the default routing policy is the long-context lane: a 1M-token
 * window at a fraction of frontier pricing is what makes "the pack does not
 * fit anywhere else" a solvable case rather than a failure.
 *
 * Prices are USD per 1M tokens for prompts under 200k; Google charges more
 * above that threshold. The catalogue uses the lower tier, so a very large
 * pack is under-estimated rather than over-estimated — the direction that
 * risks a budget surprise, which is why the budget guard checks measured spend
 * after each call and not only the estimate before it.
 */
const MODELS: ModelDescriptor[] = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    capabilities: ['code', 'strong-reasoning', 'long-context', 'vision', 'tool-use', 'frontend'],
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.31 },
    throughputTps: 60,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    capabilities: ['cheap-ok', 'code', 'long-context', 'vision', 'tool-use'],
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5, cachedInputPerMTok: 0.075 },
    throughputTps: 180,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
  },
];

export class GoogleAdapter extends BaseAdapter {
  readonly id = 'google';
  readonly name = 'Google Gemini';
  readonly kind = 'byok' as const;
  readonly transport = 'http' as const;

  private client?: GoogleGenAI;
  private clientKey?: string;
  private account = 'default';

  constructor() {
    super();
    this.models = MODELS;
    this.defaultModel = 'gemini-2.5-flash';
  }

  setAccount(account: string): void {
    this.account = account;
    this.client = undefined;
  }

  private getClient(): GoogleGenAI | undefined {
    const apiKey = getSecret('google', this.account);
    if (!apiKey) return undefined;
    if (!this.client || this.clientKey !== apiKey) {
      this.client = new GoogleGenAI({ apiKey });
      this.clientKey = apiKey;
    }
    return this.client;
  }

  async probe(): Promise<ProviderProbeResult> {
    const available = Boolean(getSecret('google', this.account));
    return {
      available,
      detail: available
        ? `key configured (${this.account})`
        : 'Add a Google AI Studio key in Settings, or set GOOGLE_API_KEY',
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
        error: { kind: 'auth', message: 'No Google API key configured' },
        at: Date.now(),
      };
      return;
    }

    const model = this.modelById(request.model) ?? this.models[0]!;
    yield { type: 'start', runId: request.runId, providerId: this.id, model: model.id, at: Date.now() };
    this.countRequest();

    const contents = request.messages.map((m) => ({
      role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [
        ...(m.images ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
        { text: m.content },
      ],
    }));

    const stream = await client.models.generateContentStream({
      model: model.id,
      contents,
      config: {
        systemInstruction: request.system,
        maxOutputTokens: Math.min(request.maxOutputTokens ?? 16_000, model.maxOutputTokens),
        abortSignal: signal,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
    });

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInput: number | undefined;
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      const piece = chunk.text;
      if (piece) {
        text += piece;
        yield { type: 'delta', runId: request.runId, text: piece };
      }
      for (const call of chunk.functionCalls ?? []) {
        yield {
          type: 'tool-call',
          runId: request.runId,
          name: call.name ?? 'unknown',
          input: call.args ?? {},
          callId: call.id ?? `call_${Date.now()}`,
        };
      }
      // Usage arrives on the final chunk and is cumulative, so last write wins.
      const usage = chunk.usageMetadata;
      if (usage) {
        inputTokens = usage.promptTokenCount ?? inputTokens;
        outputTokens = usage.candidatesTokenCount ?? outputTokens;
        cachedInput = usage.cachedContentTokenCount ?? cachedInput;
      }
      const reason = chunk.candidates?.[0]?.finishReason;
      if (reason) finishReason = String(reason);
    }

    const measured = inputTokens > 0 || outputTokens > 0;
    if (!measured) {
      inputTokens = estimateTokens(request.system + request.messages.map((m) => m.content).join('\n'));
      outputTokens = estimateTokens(text);
    }

    // Gemini reports a safety block as a finish reason on a 200 response.
    // Reporting it as a successful empty completion would look like the model
    // simply produced nothing, which is a much harder failure to diagnose.
    if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
      yield {
        type: 'error',
        runId: request.runId,
        error: { kind: 'invalid-request', message: `Gemini blocked this response (${finishReason})` },
        at: Date.now(),
      };
      return;
    }

    const usage = this.usageOf(model.id, inputTokens, outputTokens, cachedInput, measured);
    yield { type: 'usage', runId: request.runId, usage };
    yield { type: 'done', runId: request.runId, text, usage, at: Date.now() };

    if (finishReason === 'MAX_TOKENS') {
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

    // The Google SDK surfaces HTTP failures as an error whose message carries
    // the status, so the status is parsed out rather than read from a field.
    const message = errorMessage(err);
    const status = (err as { status?: number }).status ?? Number(/\b(4\d\d|5\d\d)\b/.exec(message)?.[1]);

    if (status === 429 || /RESOURCE_EXHAUSTED/i.test(message)) {
      return { kind: 'quota', message, status: 429 };
    }
    if (status === 400 && /API key not valid/i.test(message)) {
      return { kind: 'auth', message, status };
    }
    return super.classifyError(Number.isFinite(status) ? Object.assign(err as object, { status }) : err);
  }
}
