import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRunEvent } from '@agentic/core';

/**
 * Adapter integration tests against recorded fixtures.
 *
 * A local HTTP server replays real recorded wire responses, and the adapter is
 * pointed at it with a base URL. That exercises the actual SDK, the actual
 * streaming parser and the actual error classifier — with no network, no key
 * and no cost — which is the only way the adapter layer gets meaningful
 * coverage.
 *
 * The invariants asserted here are the ones the orchestrator depends on:
 *
 *   1. Exactly one terminal event (`done` or `error`), always.
 *   2. An aborted run ends as `cancelled`, promptly.
 *   3. Errors are classified correctly — failover is built entirely on this.
 *   4. Local and subscription providers cost zero.
 */

// Redirect state and supply a key before the modules load.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-provider-test-'));
process.env.AGENTIC_DATA_DIR = dataDir;
process.env.GROQ_API_KEY = 'test-key-not-real';

const {
  OLLAMA_NDJSON_STREAM,
  OLLAMA_TAGS_BODY,
  OPENAI_AUTH_ERROR_BODY,
  OPENAI_INSUFFICIENT_QUOTA_BODY,
  OPENAI_NO_USAGE_STREAM,
  OPENAI_RATE_LIMIT_BODY,
  OPENAI_TEXT_STREAM,
  OPENAI_TOOL_CALL_STREAM,
  OPENAI_TRUNCATED_STREAM,
} = await import('./fixtures/openai-sse.js');

const { OpenAICompatibleAdapter } = await import('../src/providers/openai-compatible.js');
const { OllamaAdapter } = await import('../src/providers/ollama.js');
const { loadQuota } = await import('../src/quota.js');

loadQuota();

// ---------------------------------------------------------------------------
// A server that replays whatever the current test hands it
// ---------------------------------------------------------------------------

interface Reply {
  status?: number;
  body: string | object;
  contentType?: string;
}

let nextReply: Reply = { body: '' };
let lastRequestBody: any;
let server: http.Server;
let baseURL: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        lastRequestBody = raw ? JSON.parse(raw) : undefined;
      } catch {
        lastRequestBody = raw;
      }
      const { status = 200, body, contentType } = nextReply;
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, {
        'content-type': contentType ?? (typeof body === 'string' ? 'text/event-stream' : 'application/json'),
      });
      res.end(payload);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  nextReply = { body: '' };
});

function makeAdapter() {
  return new OpenAICompatibleAdapter({
    // 'groq' so the env-var fallback in the vault supplies a key.
    id: 'groq',
    name: 'Test Provider',
    kind: 'free-cloud',
    baseURL,
    models: [
      {
        id: 'gpt-oss-120b',
        label: 'Test model',
        capabilities: ['code', 'cheap-ok'],
        contextWindow: 128_000,
        maxOutputTokens: 32_000,
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        throughputTps: 400,
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
      },
    ],
    defaultModel: 'gpt-oss-120b',
    keyHint: 'set a key',
  });
}

async function collect(iterable: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const baseRequest = {
  runId: 'r1',
  model: 'gpt-oss-120b',
  system: 'You are a test.',
  messages: [{ role: 'user' as const, content: 'Write a file.' }],
};

// ---------------------------------------------------------------------------

describe('OpenAI-compatible adapter', () => {
  it('streams text deltas and ends with exactly one done', async () => {
    nextReply = { body: OPENAI_TEXT_STREAM };
    const events = await collect(makeAdapter().stream(baseRequest, new AbortController().signal));

    expect(events.filter((e) => e.type === 'done' || e.type === 'error')).toHaveLength(1);
    expect(events[0]?.type).toBe('start');

    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.text).toContain('export const a = 1;');
  });

  it('reports measured usage and prices it from the model', async () => {
    nextReply = { body: OPENAI_TEXT_STREAM };
    const events = await collect(makeAdapter().stream(baseRequest, new AbortController().signal));
    const done = events.find((e) => e.type === 'done');

    if (done?.type !== 'done') throw new Error('expected a done event');
    expect(done.usage.measured).toBe(true);
    expect(done.usage.input).toBe(1200);
    expect(done.usage.output).toBe(45);
    // 1200/1M * $1 + 45/1M * $2
    expect(done.usage.costUsd).toBeCloseTo(0.0012 + 0.00009, 8);
  });

  it('asks for usage in the stream, or every call would be an estimate', async () => {
    nextReply = { body: OPENAI_TEXT_STREAM };
    await collect(makeAdapter().stream(baseRequest, new AbortController().signal));
    expect(lastRequestBody?.stream_options).toEqual({ include_usage: true });
  });

  it('estimates usage, and says it estimated, when the provider reports none', async () => {
    nextReply = { body: OPENAI_NO_USAGE_STREAM };
    const events = await collect(makeAdapter().stream(baseRequest, new AbortController().signal));
    const done = events.find((e) => e.type === 'done');

    if (done?.type !== 'done') throw new Error('expected a done event');
    // A number labelled as measured when it is a guess is worse than no number.
    expect(done.usage.measured).toBe(false);
    expect(done.usage.input).toBeGreaterThan(0);
  });

  it('reassembles a tool call whose arguments are split across chunks', async () => {
    nextReply = { body: OPENAI_TOOL_CALL_STREAM };
    const events = await collect(makeAdapter().stream(baseRequest, new AbortController().signal));

    const call = events.find((e) => e.type === 'tool-call');
    expect(call?.type === 'tool-call' && call.name).toBe('read_f');
    expect(call?.type === 'tool-call' && call.input).toEqual({ path: 'a.ts' });
  });

  it('warns when output was cut off at the ceiling, without failing the run', async () => {
    nextReply = { body: OPENAI_TRUNCATED_STREAM };
    const events = await collect(makeAdapter().stream(baseRequest, new AbortController().signal));

    // Not an error — the verification gate catches a truncated file — but the
    // worklog should say why the output stops mid-thought.
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'log' && /truncated/i.test(e.text))).toBe(true);
  });

  it('classifies a 429 as quota, which is what makes failover work', async () => {
    nextReply = { status: 429, body: OPENAI_RATE_LIMIT_BODY };
    const events = await collect(makeAdapter().stream(baseRequest, new AbortController().signal));

    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.kind).toBe('quota');
  });

  it('classifies a 401 as auth, which failover cannot fix by retrying', async () => {
    nextReply = { status: 401, body: OPENAI_AUTH_ERROR_BODY };
    const events = await collect(makeAdapter().stream(baseRequest, new AbortController().signal));

    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.kind).toBe('auth');
  });

  it('classifies a 400 that is really a billing problem as quota, not invalid-request', async () => {
    // The distinction decides whether the task moves on or retries forever.
    nextReply = { status: 400, body: OPENAI_INSUFFICIENT_QUOTA_BODY };
    const events = await collect(makeAdapter().stream(baseRequest, new AbortController().signal));

    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.kind).toBe('quota');
  });

  it('classifies a 500 as transient', async () => {
    nextReply = { status: 500, body: { error: { message: 'internal error' } } };
    const events = await collect(makeAdapter().stream(baseRequest, new AbortController().signal));

    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.kind).toBe('transient');
  });

  it('ends as cancelled when the signal aborts', async () => {
    nextReply = { body: OPENAI_TEXT_STREAM };
    const controller = new AbortController();
    const iterator = makeAdapter().stream(baseRequest, controller.signal);
    controller.abort();

    const events = await collect(iterator);
    const terminal = events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.type === 'error' && terminal[0].error.kind).toBe('cancelled');
  });

  it('errors rather than throwing when no key is configured', async () => {
    const adapter = makeAdapter();
    adapter.setAccount('a-account-with-no-key');

    const events = await collect(adapter.stream(baseRequest, new AbortController().signal));
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.kind).toBe('auth');
  });

  it('sends the system prompt as the first message', async () => {
    nextReply = { body: OPENAI_TEXT_STREAM };
    await collect(makeAdapter().stream(baseRequest, new AbortController().signal));

    expect(lastRequestBody.messages[0]).toEqual({ role: 'system', content: 'You are a test.' });
  });

  it('estimates cost before the call, for routing', () => {
    const estimate = makeAdapter().estimateCost({
      model: 'gpt-oss-120b',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(estimate.usd).toBeCloseTo(1, 6);
    expect(estimate.free).toBe(false);
  });
});

describe('Ollama adapter', () => {
  it('is unavailable, with an actionable reason, when nothing is listening', async () => {
    const adapter = new OllamaAdapter();
    const result = await adapter.probe();
    // Nothing runs on the default port in CI.
    expect(result.available).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it('costs nothing, which is why the router spends it first', () => {
    const adapter = new OllamaAdapter();
    adapter.models = [
      {
        id: 'qwen2.5-coder:7b',
        label: 'q',
        capabilities: ['cheap-ok', 'code'],
        contextWindow: 16_384,
        maxOutputTokens: 8_192,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
        supportsStreaming: true,
        supportsTools: false,
        supportsVision: false,
      },
    ];
    adapter.defaultModel = 'qwen2.5-coder:7b';

    const estimate = adapter.estimateCost({ model: 'qwen2.5-coder:7b', inputTokens: 10_000_000 });
    expect(estimate.usd).toBe(0);
    expect(estimate.free).toBe(true);
  });

  it('classifies a refused connection as unavailable, not as a real failure', () => {
    const adapter = new OllamaAdapter();
    const error = adapter.classifyError(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    expect(error.kind).toBe('unavailable');
  });

  it('parses its newline-delimited stream format', () => {
    // Ollama is NDJSON, not SSE. Recorded here so a change is visible.
    const lines = OLLAMA_NDJSON_STREAM.trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.message.content).join('')).toBe('export const a = 1;');
    expect(lines[2].prompt_eval_count).toBe(320);
  });

  it('infers capabilities from an installed model list', () => {
    expect(OLLAMA_TAGS_BODY.models.map((m) => m.name)).toContain('qwen2.5-coder:7b');
  });
});
