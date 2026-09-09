import type { CostEstimate, CostEstimateRequest, ProviderAdapter } from '../src/provider.js';
import { defaultTierFor, priceOf } from '../src/provider.js';
import type {
  AgentRunError,
  AgentRunEvent,
  Capability,
  ModelDescriptor,
  ProviderKind,
  QuotaState,
  Task,
  TokenUsage,
} from '../src/types.js';

/** A model descriptor with sensible defaults, overridable per test. */
export function makeModel(over: Partial<ModelDescriptor> & { id: string }): ModelDescriptor {
  return {
    label: over.id,
    capabilities: ['code'],
    contextWindow: 200_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    throughputTps: 60,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    ...over,
  };
}

export function makeQuota(over: Partial<QuotaState> = {}): QuotaState {
  return {
    usedMinute: 0,
    usedDay: 0,
    tokensToday: { input: 0, output: 0 },
    costTodayUsd: 0,
    account: 'default',
    ...over,
  };
}

export interface FakeAdapterOptions {
  id: string;
  name?: string;
  kind?: ProviderKind;
  tier?: number;
  models?: ModelDescriptor[];
  quota?: QuotaState;
  /** Events the adapter emits from `stream()`. */
  script?: AgentRunEvent[];
}

/**
 * A `ProviderAdapter` that talks to nothing. Every router and orchestrator test
 * runs against these — no network, no subprocess, no recorded fixtures needed
 * for the logic layer.
 */
export class FakeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly transport = 'http' as const;
  tier: number;
  models: ModelDescriptor[];
  defaultModel: string;
  quota: QuotaState;
  script: AgentRunEvent[];
  /** Every request that reached `stream()`, for assertions. */
  calls: { model: string; system: string }[] = [];

  constructor(opts: FakeAdapterOptions) {
    this.id = opts.id;
    this.name = opts.name ?? opts.id;
    this.kind = opts.kind ?? 'byok';
    this.tier = opts.tier ?? defaultTierFor(this.kind);
    this.models = opts.models ?? [makeModel({ id: `${opts.id}-model` })];
    this.defaultModel = this.models[0]!.id;
    this.quota = opts.quota ?? makeQuota();
    this.script = opts.script ?? [];
  }

  async probe() {
    return { available: true };
  }

  async *stream(req: { runId: string; model: string; system: string }): AsyncIterable<AgentRunEvent> {
    this.calls.push({ model: req.model, system: req.system });
    if (this.script.length) {
      for (const e of this.script) yield e;
      return;
    }
    yield { type: 'start', runId: req.runId, providerId: this.id, model: req.model, at: Date.now() };
    yield {
      type: 'done',
      runId: req.runId,
      text: 'ok',
      usage: { input: 10, output: 10, costUsd: 0, measured: true },
      at: Date.now(),
    };
  }

  estimateCost(req: CostEstimateRequest): CostEstimate {
    const model = this.models.find((m) => m.id === req.model) ?? this.models[0]!;
    const free = this.kind === 'local' || this.kind === 'subscription';
    const usd = free
      ? 0
      : priceOf(model, {
          input: req.inputTokens,
          output: req.outputTokens ?? 1000,
          cachedInput: req.cachedInputTokens,
        });
    return {
      usd,
      free,
      model: model.id,
      etaSeconds: (req.outputTokens ?? 1000) / (model.throughputTps ?? 40),
    };
  }

  getQuotaState(): QuotaState {
    return this.quota;
  }

  recordUsage(usage: TokenUsage): void {
    this.quota.usedMinute++;
    this.quota.usedDay++;
    this.quota.tokensToday.input += usage.input;
    this.quota.tokensToday.output += usage.output;
    this.quota.costTodayUsd += usage.costUsd;
  }

  classifyError(err: unknown): AgentRunError {
    return { kind: 'unknown', message: String(err) };
  }
}

let taskSeq = 0;

export function makeTask(over: Partial<Task> & { id?: string } = {}): Task {
  const id = over.id ?? `t${++taskSeq}`;
  const now = Date.now();
  return {
    id,
    planId: 'p1',
    title: `Task ${id}`,
    description: 'do the thing',
    capability: 'code' as Capability,
    dependsOn: [],
    status: 'planned',
    complexity: 3,
    acceptance: [],
    attempts: [],
    maxAttempts: 3,
    worklog: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** Build a small graph from a compact `id: deps` spec, for readable tests. */
export function graph(spec: Record<string, string[]>, over: Partial<Task> = {}): Task[] {
  return Object.entries(spec).map(([id, dependsOn]) => makeTask({ id, dependsOn, ...over }));
}
