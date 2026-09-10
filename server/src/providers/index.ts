import type { ProviderAdapter, ProviderStatus } from '@agentic/core';
import { AnthropicAdapter } from './anthropic.js';
import { GoogleAdapter } from './google.js';
import { OllamaAdapter } from './ollama.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { PROVIDER_CONFIGS, customEndpointConfig } from './catalog.js';
import { CLI_AGENTS, CliAgentAdapter } from './cli-agents.js';
import type { AgentPermissions } from './cli-agents.js';
import { BaseAdapter } from './base.js';
import { describeError, log } from '../log.js';
import { state } from '../store.js';

/**
 * The provider registry.
 *
 * This is the ONLY module outside `providers/` that anything else imports to
 * reach a model. The orchestrator asks for adapters; it never constructs one,
 * never names a vendor, and never learns whether it got an HTTP client or a
 * subprocess.
 */

export interface RegisteredProvider {
  adapter: ProviderAdapter;
  available: boolean;
  detail?: string;
  lastProbedAt: number;
}

const registry = new Map<string, RegisteredProvider>();

/** Every adapter, regardless of availability. */
export function allProviders(): RegisteredProvider[] {
  return [...registry.values()];
}

/**
 * Adapters the router may choose from: probed available, not disabled by the
 * user. Cooldowns and rate limits are the router's business, not this one's,
 * because they are per-decision rather than per-provider.
 */
export function availableProviders(): ProviderAdapter[] {
  const disabled = new Set(state.config.disabledProviders);
  return [...registry.values()]
    .filter((p) => p.available && !disabled.has(p.adapter.id))
    .map((p) => p.adapter);
}

export function getProvider(id: string): ProviderAdapter | undefined {
  return registry.get(id)?.adapter;
}

export function providerStatuses(): ProviderStatus[] {
  const disabled = new Set(state.config.disabledProviders);
  return [...registry.values()]
    .map(({ adapter, available, detail }) => ({
      id: adapter.id,
      name: adapter.name,
      kind: adapter.kind,
      transport: adapter.transport,
      tier: adapter instanceof BaseAdapter ? adapter.ladderTier : adapter.tier,
      models: adapter.models,
      defaultModel: adapter.defaultModel,
      available: available && !disabled.has(adapter.id),
      detail: disabled.has(adapter.id) ? 'Disabled in Settings' : detail,
      quota: adapter.getQuotaState(),
    }))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
}

function register(adapter: ProviderAdapter): void {
  registry.set(adapter.id, { adapter, available: false, lastProbedAt: 0 });
}

/**
 * Build the registry. Order does not matter — the ladder is computed from tier
 * and policy, not from registration order.
 */
/** Catalogue providers that are not offered, by id. */
const EXCLUDED_PROVIDERS = new Set(['groq']);

export function buildRegistry(): void {
  registry.clear();

  register(new OllamaAdapter());
  // Groq is deliberately excluded. It is fast and free, and on real work it
  // produced markedly worse output than the subscription agents — handed a
  // repair after two Claude Code attempts it made the page worse rather than
  // better. A ladder rung that costs nothing and undoes progress is not a
  // saving. Delete this filter to put it back.
  for (const config of PROVIDER_CONFIGS.filter((c) => !EXCLUDED_PROVIDERS.has(c.id))) {
    register(new OpenAICompatibleAdapter(config));
  }
  register(new AnthropicAdapter());
  register(new GoogleAdapter());
  for (const config of CLI_AGENTS) register(new CliAgentAdapter(config));

  // The generic endpoint only exists once the user has configured a base URL.
  const custom = process.env.OPENAI_COMPATIBLE_BASE_URL;
  if (custom) {
    const models = (process.env.OPENAI_COMPATIBLE_MODELS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => ({ id }));
    if (models.length) {
      register(new OpenAICompatibleAdapter(customEndpointConfig({ baseURL: custom, models })));
    } else {
      log(
        'OPENAI_COMPATIBLE_BASE_URL is set but OPENAI_COMPATIBLE_MODELS is empty — endpoint skipped',
        'warn',
      );
    }
  }
}

/**
 * Probe every provider.
 *
 * Probes run concurrently and none may throw: an adapter whose probe fails is
 * unavailable with a reason, never an exception that takes the sweep down.
 * Availability changes are logged, because "why did my provider disappear" is
 * a question the activity feed should already answer.
 */
export async function probeAll(): Promise<void> {
  await Promise.all(
    [...registry.values()].map(async (entry) => {
      const wasAvailable = entry.available;
      try {
        const result = await entry.adapter.probe();
        entry.available = result.available;
        entry.detail = result.detail;
        if (result.models?.length) entry.adapter.models = result.models;
      } catch (err) {
        entry.available = false;
        entry.detail = `Probe failed: ${describeError(err)}`;
      }
      entry.lastProbedAt = Date.now();

      if (entry.available !== wasAvailable && entry.lastProbedAt > 0) {
        log(
          entry.available
            ? `${entry.adapter.name} is now available — ${entry.detail ?? 'ready'}`
            : `${entry.adapter.name} became unavailable — ${entry.detail ?? 'unknown reason'}`,
          entry.available ? 'info' : 'warn',
        );
      }
    }),
  );
}

/**
 * Re-probe periodically, so installing a CLI or pasting a key lights the
 * provider up without a restart.
 */
export function startProbeLoop(intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    void probeAll();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Apply the yolo/manual permission setting to every CLI agent. */
export function setAgentPermissions(mode: AgentPermissions): void {
  for (const { adapter } of registry.values()) {
    if (adapter instanceof CliAgentAdapter) adapter.setPermissions(mode);
  }
}

/** Switch a provider to a named credential. */
export function setProviderAccount(providerId: string, account: string): boolean {
  const adapter = registry.get(providerId)?.adapter;
  if (!adapter?.setAccount) return false;
  adapter.setAccount(account);
  void probeAll();
  return true;
}

/**
 * The priciest connected model, used as the counterfactual baseline in the cost
 * dashboard ("what routing saved"). Providers that are free are excluded — a
 * baseline of zero would make every saving read as zero.
 */
export function mostExpensiveRates(): { in: number; out: number } {
  let worst = { in: 0, out: 0 };
  for (const { adapter, available } of registry.values()) {
    if (!available) continue;
    for (const model of adapter.models) {
      if (model.pricing.inputPerMTok > worst.in)
        worst = { in: model.pricing.inputPerMTok, out: model.pricing.outputPerMTok };
    }
  }
  return worst;
}

export { BaseAdapter };
export type { AgentPermissions };
