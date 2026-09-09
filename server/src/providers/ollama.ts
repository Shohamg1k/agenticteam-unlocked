import type {
  AgentRunError,
  AgentRunEvent,
  CompletionRequest,
  ModelDescriptor,
  ProviderProbeResult,
} from '@agentic/core';
import { estimateTokens } from '@agentic/core';
import { BaseAdapter, guardStream, isAbortError } from './base.js';

/**
 * Ollama — models running on this machine.
 *
 * Tier 0 on the ladder: unlimited, free, no account, works offline. That is the
 * floor the whole product stands on — every other provider can be exhausted or
 * unreachable and a plan still moves.
 *
 * There is no SDK here on purpose. Ollama's API is two endpoints, and adding a
 * dependency to call them would be more code than calling them.
 */

const OLLAMA_URL = process.env.OLLAMA_HOST?.replace(/\/$/, '') ?? 'http://127.0.0.1:11434';

/**
 * Context windows are the model's trained maximum, but Ollama serves a smaller
 * window by default (2k unless `num_ctx` is raised). We request a larger one
 * per call and advertise a conservative figure, because a router that believes
 * a 128k window and gets 2k silently truncates the pack — the worst outcome,
 * since the model then answers a question it was never shown.
 */
const DEFAULT_NUM_CTX = 16_384;

export class OllamaAdapter extends BaseAdapter {
  readonly id = 'ollama';
  readonly name = 'Ollama (local)';
  readonly kind = 'local' as const;
  readonly transport = 'http' as const;

  constructor() {
    super();
    this.defaultModel = '';
  }

  async probe(): Promise<ProviderProbeResult> {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2_500) });
      if (!res.ok) {
        return { available: false, detail: `Ollama replied ${res.status}` };
      }
      const body = (await res.json()) as {
        models?: { name: string; details?: { parameter_size?: string } }[];
      };
      const installed = body.models ?? [];

      if (!installed.length) {
        return {
          available: false,
          detail: 'Ollama is running but has no models. Try: ollama pull qwen2.5-coder:7b',
        };
      }

      const models = installed.map((m) => this.describe(m.name, m.details?.parameter_size));
      this.models = models;
      this.defaultModel = process.env.OLLAMA_MODEL ?? preferredLocalModel(models);

      return { available: true, detail: `${models.length} model(s) installed`, models };
    } catch (err) {
      const offline = isAbortError(err) || (err as NodeJS.ErrnoException)?.code === 'ECONNREFUSED';
      return {
        available: false,
        detail: offline
          ? 'Ollama is not running. Install it from ollama.com to get a free local model.'
          : `Could not reach Ollama: ${String(err)}`,
      };
    }
  }

  /**
   * Infer capabilities from the model name. Crude, but the alternative is a
   * hard-coded table of every model anyone might pull, which would be wrong
   * more often. Local models are always `cheap-ok`; a coder-tagged model also
   * claims `code`; nothing local claims `strong-reasoning`, because promoting
   * a 7B model into the architecture lane produces confidently wrong designs.
   */
  private describe(name: string, parameterSize?: string): ModelDescriptor {
    const lower = name.toLowerCase();
    const capabilities: ModelDescriptor['capabilities'] = ['cheap-ok'];
    if (/coder|code|deepseek|qwen|starcoder|codellama|granite/.test(lower)) capabilities.push('code');
    if (/llava|vision|moondream|minicpm-v/.test(lower)) capabilities.push('vision');

    const billions = Number(/(\d+(?:\.\d+)?)\s*b/i.exec(parameterSize ?? lower)?.[1] ?? 7);
    return {
      id: name,
      label: `${name} (local)`,
      capabilities,
      contextWindow: DEFAULT_NUM_CTX,
      maxOutputTokens: 8_192,
      // Local inference has no per-token price. Zero is the honest number, and
      // it is why the free-first policy exhausts this provider before any key.
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      // Larger models are slower on the same hardware; the ranking only needs
      // to be ordinally right.
      throughputTps: Math.max(5, Math.round(200 / Math.max(1, billions))),
      supportsStreaming: true,
      supportsTools: /qwen|llama3|mistral|firefunction/.test(lower),
      supportsVision: capabilities.includes('vision'),
    };
  }

  stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    return guardStream(this, request.runId, () => this.run(request, signal));
  }

  private async *run(request: CompletionRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent> {
    const modelId = this.modelById(request.model)?.id ?? this.defaultModel;
    if (!modelId) {
      yield {
        type: 'error',
        runId: request.runId,
        error: { kind: 'unavailable', message: 'No local Ollama model is installed' },
        at: Date.now(),
      };
      return;
    }

    yield { type: 'start', runId: request.runId, providerId: this.id, model: modelId, at: Date.now() };
    this.countRequest();

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: modelId,
        stream: true,
        messages: [
          { role: 'system', content: request.system },
          ...request.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.images?.length ? { images: m.images.map((i) => i.base64) } : {}),
          })),
        ],
        options: {
          num_ctx: DEFAULT_NUM_CTX,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
      }),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      yield {
        type: 'error',
        runId: request.runId,
        error: {
          kind: res.status >= 500 ? 'transient' : 'invalid-request',
          message: `Ollama returned ${res.status}: ${detail.slice(0, 300)}`,
          status: res.status,
        },
        at: Date.now(),
      };
      return;
    }

    // Ollama streams newline-delimited JSON, one object per line.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      // The last element may be a partial line; keep it for the next chunk.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: {
          message?: { content?: string };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const piece = parsed.message?.content;
        if (piece) {
          text += piece;
          yield { type: 'delta', runId: request.runId, text: piece };
        }
        if (parsed.done) {
          inputTokens = parsed.prompt_eval_count ?? 0;
          outputTokens = parsed.eval_count ?? 0;
        }
      }
    }

    const measured = inputTokens > 0 || outputTokens > 0;
    const usage = this.usageOf(
      modelId,
      measured
        ? inputTokens
        : estimateTokens(request.system + request.messages.map((m) => m.content).join('\n')),
      measured ? outputTokens : estimateTokens(text),
      undefined,
      measured,
    );

    yield { type: 'usage', runId: request.runId, usage };
    yield { type: 'done', runId: request.runId, text, usage, at: Date.now() };
  }

  override classifyError(err: unknown): AgentRunError {
    if (isAbortError(err)) return { kind: 'cancelled', message: 'Cancelled' };
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ECONNREFUSED') {
      return { kind: 'unavailable', message: 'Ollama is not running', code };
    }
    return super.classifyError(err);
  }
}

/**
 * Which installed model to default to. A coder-tuned model beats a general one
 * for this product's workload, and a mid-size model beats a huge one that will
 * swap on a laptop.
 */
function preferredLocalModel(models: ModelDescriptor[]): string {
  const ranked = [...models].sort((a, b) => {
    const score = (m: ModelDescriptor) =>
      (m.capabilities.includes('code') ? 2 : 0) + (m.throughputTps ?? 0) / 1000;
    return score(b) - score(a);
  });
  return ranked[0]?.id ?? '';
}
