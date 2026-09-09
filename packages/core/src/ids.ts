/**
 * Id generation.
 *
 * `@agentic/core` is imported by both the server and the browser bundle, so it
 * must not reach for `node:crypto` — that is not bundleable for the renderer
 * and would drag a Node polyfill into the app.
 *
 * `globalThis.crypto` is the Web Crypto API, present as a global in browsers
 * and in Node 19+. The `getRandomValues` path covers older runtimes and secure
 * contexts where `randomUUID` is absent; the `Math.random` path exists only so
 * that an exotic runtime degrades rather than throwing. Ids here name plans and
 * tasks — they are not security tokens — so that last fallback is acceptable,
 * and it is ordered last precisely because it is the weakest.
 */

function randomHex(length: number): string {
  const webCrypto = globalThis.crypto;

  if (webCrypto?.randomUUID) {
    return webCrypto.randomUUID().replaceAll('-', '').slice(0, length);
  }

  if (webCrypto?.getRandomValues) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    webCrypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, length);
  }

  let out = '';
  while (out.length < length) out += Math.random().toString(16).slice(2);
  return out.slice(0, length);
}

/**
 * Short, sortable-enough, human-quotable ids. Prefixed by kind so a stray id in
 * a log line tells you what it points at without a lookup.
 */
export function rid(prefix: string): string {
  return `${prefix}_${randomHex(12)}`;
}

export const newTaskId = () => rid('t');
export const newPlanId = () => rid('p');
export const newRunId = () => rid('r');
export const newCheckpointId = () => rid('cp');
export const newMessageId = () => rid('m');
