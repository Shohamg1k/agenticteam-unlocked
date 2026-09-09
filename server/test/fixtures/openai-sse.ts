/**
 * Recorded wire responses.
 *
 * These are the actual shapes providers return, captured once and replayed by
 * `providers.test.ts` against a local HTTP server. Recording them means the
 * adapter layer is tested against real protocol quirks — split tool-call
 * arguments, usage arriving only on the final chunk, an error body shaped
 * nothing like a success — without a network or a key.
 *
 * When a provider changes its wire format, the fix is to re-record the fixture
 * and watch the test fail. That is the point of keeping them as data.
 */

const sse = (events: unknown[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';

/** A plain completion: three text deltas, then usage on the final chunk. */
export const OPENAI_TEXT_STREAM = sse([
  {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'gpt-oss-120b',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-1',
    choices: [{ index: 0, delta: { content: 'FILE: src/a.ts\n' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-1',
    choices: [{ index: 0, delta: { content: '```ts\nexport const a = 1;\n' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-1',
    choices: [{ index: 0, delta: { content: '```\n' }, finish_reason: 'stop' }],
  },
  {
    id: 'chatcmpl-1',
    choices: [],
    // Only present because the request asked for it; without stream_options
    // every call would be an estimate rather than a measurement.
    usage: { prompt_tokens: 1200, completion_tokens: 45, total_tokens: 1245 },
  },
]);

/**
 * A tool call. Arguments arrive split across chunks and keyed by index, which
 * is the detail an adapter written from the docs alone usually gets wrong.
 */
export const OPENAI_TOOL_CALL_STREAM = sse([
  {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'call_abc', type: 'function', function: { name: 'read_f', arguments: '' } },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] },
        finish_reason: null,
      },
    ],
  },
  {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] },
        finish_reason: 'tool_calls',
      },
    ],
  },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]);

/** A completion cut off at the token ceiling. */
export const OPENAI_TRUNCATED_STREAM = sse([
  { choices: [{ index: 0, delta: { content: 'export function partial(' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 4000 } },
]);

/** A provider that streams without ever reporting usage. */
export const OPENAI_NO_USAGE_STREAM = sse([
  { choices: [{ index: 0, delta: { content: 'hello world' }, finish_reason: 'stop' }] },
]);

export const OPENAI_RATE_LIMIT_BODY = {
  error: {
    message:
      'Rate limit reached for gpt-oss-120b in organization org-x on requests per min (RPM): Limit 30, Used 30.',
    type: 'requests',
    code: 'rate_limit_exceeded',
  },
};

export const OPENAI_AUTH_ERROR_BODY = {
  error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' },
};

/**
 * A 400 whose body is really a billing problem. Classifying this as
 * invalid-request would retry it forever on a provider that will never accept
 * it; classifying it as quota moves the task on, which is correct.
 */
export const OPENAI_INSUFFICIENT_QUOTA_BODY = {
  error: {
    message: 'You exceeded your current quota, please check your plan and billing details.',
    type: 'insufficient_quota',
    code: 'insufficient_quota',
  },
};

/** Ollama streams newline-delimited JSON, not SSE. */
export const OLLAMA_NDJSON_STREAM =
  [
    { model: 'qwen2.5-coder', message: { role: 'assistant', content: 'export ' }, done: false },
    { model: 'qwen2.5-coder', message: { role: 'assistant', content: 'const a = 1;' }, done: false },
    {
      model: 'qwen2.5-coder',
      message: { role: 'assistant', content: '' },
      done: true,
      prompt_eval_count: 320,
      eval_count: 12,
    },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n') + '\n';

export const OLLAMA_TAGS_BODY = {
  models: [
    { name: 'qwen2.5-coder:7b', details: { parameter_size: '7B' } },
    { name: 'llama3.2:3b', details: { parameter_size: '3B' } },
  ],
};
