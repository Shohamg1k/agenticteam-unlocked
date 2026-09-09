import type {
  AgentRunError,
  AgentRunEvent,
  CompletionRequest,
  CostEstimate,
  CostEstimateRequest,
  ModelDescriptor,
  ProviderAdapter,
  ProviderKind,
  ProviderProbeResult,
  ProviderTransport,
  QuotaState,
  TokenUsage,
} from '@agentic/core';
import { defaultTierFor, looksLikeAuthError, looksLikeQuotaError, priceOf } from '@agentic/core';
import { quotaState, recordRequest, recordUsage as recordLedgerUsage } from '../quota.js';
import type { Limits } from '../quota.js';

/**
 * Shared adapter behaviour.
 *
 * Everything here is provider-agnostic: the quota ledger, cost arithmetic, the
 * fallback error classifier, and the invariants every adapter must satisfy.
 * Subclasses supply `probe()` and `stream()` and nothing else is required.
 *
 * The invariants (asserted by `test/providers.conformance.test.ts`):
 *  1. `stream()` emits exactly one terminal event — `done` or `error`.
 *  2. Aborting the signal produces a `cancelled` error, promptly.
 *  3. `estimateCost()` returns 0 for local and subscription providers.
 *  4. No method throws; failures arrive as an `error` event.
 */
export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly kind: ProviderKind;
  abstract readonly transport: ProviderTransport;

  tier: number;
  models: ModelDescriptor[] = [];
  defaultModel = '';
  /** Provider-declared request caps, when it publishes any. */
  limits?: Limits;

  constructor(tierOverride?: number) {
    // `kind` is not readable in a base constructor before the subclass field
    // initialiser runs, so the tier is resolved lazily on first read instead.
    this.tier = tierOverride ?? -1;
  }

  /** Resolve the ladder rung, defaulting from `kind` on first use. */
  get ladderTier(): number {
    if (this.tier < 0) this.tier = defaultTierFor(this.kind);
    return this.tier;
  }

  abstract probe(): Promise<ProviderProbeResult>;

  abstract stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<AgentRunEvent>;

  modelById(id: string): ModelDescriptor | undefined {
    return this.models.find((m) => m.id === id) ?? this.models.find((m) => m.id === this.defaultModel);
  }

  /** True when this provider is not billed per token. */
  get isFree(): boolean {
    return this.kind === 'local' || this.kind === 'subscription';
  }

  estimateCost(req: CostEstimateRequest): CostEstimate {
    const model = this.modelById(req.model);
    if (!model) return { usd: 0, free: this.isFree, model: req.model };

    const outputTokens = req.outputTokens ?? Math.min(4_000, Math.floor(model.maxOutputTokens / 4));
    const usd = this.isFree
      ? 0
      : priceOf(model, { input: req.inputTokens, output: outputTokens, cachedInput: req.cachedInputTokens });

    return {
      usd,
      free: this.isFree,
      model: model.id,
      etaSeconds: Math.round(outputTokens / Math.max(1, model.throughputTps ?? 40)),
    };
  }

  getQuotaState(): QuotaState {
    return quotaState(this.id, this.limits);
  }

  recordUsage(usage: TokenUsage): void {
    recordLedgerUsage(this.id, usage);
  }

  /** Called by subclasses immediately before a request leaves. */
  protected countRequest(): void {
    recordRequest(this.id);
  }

  /**
   * Fallback classifier. Subclasses override to use their SDK's typed errors,
   * and call `super.classifyError` for anything they do not recognise.
   */
  classifyError(err: unknown): AgentRunError {
    if (isAbortError(err)) return { kind: 'cancelled', message: 'Cancelled' };

    const message = errorMessage(err);
    const status = (err as { status?: number })?.status;

    if (status === 429) return { kind: 'quota', message, status, retryAfterMs: retryAfterFrom(err) };
    if (status === 401 || status === 403) return { kind: 'auth', message, status };
    if (status === 400 || status === 422) return { kind: 'invalid-request', message, status };
    if (typeof status === 'number' && status >= 500) return { kind: 'transient', message, status };

    if (looksLikeQuotaError(message)) return { kind: 'quota', message, retryAfterMs: retryAfterFrom(err) };
    if (looksLikeAuthError(message)) return { kind: 'auth', message };

    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
      return { kind: 'transient', message, code };
    }
    if (code === 'ENOENT') return { kind: 'unavailable', message, code };

    return { kind: 'unknown', message };
  }

  /** Compute usage with cost, for adapters whose provider reports token counts. */
  protected usageOf(
    modelId: string,
    input: number,
    output: number,
    cachedInput?: number,
    measured = true,
  ): TokenUsage {
    const model = this.modelById(modelId);
    const costUsd = model && !this.isFree ? priceOf(model, { input, output, cachedInput }) : 0;
    return { input, output, cachedInput, costUsd, measured };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name;
  return (
    name === 'AbortError' || name === 'APIUserAbortError' || /aborted|cancell?ed/i.test(errorMessage(err))
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  const asObj = err as { message?: string; error?: { message?: string } };
  return asObj?.error?.message ?? asObj?.message ?? String(err);
}

/** Pull a retry-after out of a provider error, in ms, when one is present. */
export function retryAfterFrom(err: unknown): number | undefined {
  const headers = (err as { headers?: Record<string, string> | Headers })?.headers;
  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : (headers?.['retry-after'] ?? headers?.['Retry-After'] ?? undefined);
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Turn a `stream()` implementation into one that is guaranteed to satisfy the
 * terminal-event invariant, even if the body throws halfway through.
 *
 * Every adapter wraps its generator in this, so a provider SDK throwing an
 * unexpected shape becomes a well-formed `error` event rather than an
 * unhandled rejection that wedges a worker.
 */
export async function* guardStream(
  adapter: BaseAdapter,
  runId: string,
  body: () => AsyncIterable<AgentRunEvent>,
): AsyncIterable<AgentRunEvent> {
  let terminated = false;
  try {
    for await (const event of body()) {
      if (event.type === 'done' || event.type === 'error') terminated = true;
      yield event;
    }
  } catch (err) {
    if (!terminated) {
      yield { type: 'error', runId, error: adapter.classifyError(err), at: Date.now() };
      terminated = true;
    }
    return;
  }
  if (!terminated) {
    yield {
      type: 'error',
      runId,
      error: { kind: 'unknown', message: `${adapter.name} ended the stream without a result` },
      at: Date.now(),
    };
  }
}
