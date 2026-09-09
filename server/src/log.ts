import type { ActivityEntry } from '@agentic/core';
import { rid } from '@agentic/core';

/**
 * Activity log.
 *
 * Two audiences, one call site:
 *  - the terminal, for whoever is running the server;
 *  - the UI's activity feed, which is part of the product — "what is the team
 *    doing right now" is a question the app must always be able to answer.
 *
 * Secret redaction happens here rather than at each call site, because a rule
 * that depends on every future caller remembering it is not a rule.
 */

const MAX_ENTRIES = 500;

export const activity: ActivityEntry[] = [];

type Listener = (entry: ActivityEntry) => void;
const listeners = new Set<Listener>();

export function onActivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Patterns that look like credentials. Redaction is best-effort and
 * deliberately over-eager: a redacted log line is a small annoyance, a leaked
 * key in a log file the user pastes into an issue is not.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic, Groq
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub
  /\bAIza[A-Za-z0-9_-]{20,}/g, // Google
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
  /\b(api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["']?[^\s"',]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

export interface LogScope {
  projectId?: string;
  planId?: string;
  taskId?: string;
}

export function log(
  text: string,
  level: ActivityEntry['level'] = 'info',
  scope: LogScope = {},
): ActivityEntry {
  const entry: ActivityEntry = { id: rid('a'), ts: Date.now(), level, text: redact(text), ...scope };
  activity.push(entry);
  if (activity.length > MAX_ENTRIES) activity.splice(0, activity.length - MAX_ENTRIES);

  const prefix = level === 'error' ? '[agentic:error]' : level === 'warn' ? '[agentic:warn]' : '[agentic]';

  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`${prefix} ${entry.text}`);

  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      // A broken listener must not take down the thing it was listening to.
    }
  }
  return entry;
}

export const logWarn = (text: string, scope?: LogScope) => log(text, 'warn', scope);
export const logError = (text: string, scope?: LogScope) => log(text, 'error', scope);

/**
 * Format an unknown thrown value into something a human can act on.
 * Never returns an empty string, because "Error: " with nothing after it is the
 * single most useless log line a program can emit.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause ? ` (caused by: ${describeError(cause)})` : '';
    return `${err.message || err.name || 'Error'}${causeText}`;
  }
  if (typeof err === 'string' && err.trim()) return err;
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}' && json !== 'null') return json;
  } catch {
    // Fall through to the last resort.
  }
  return String(err) || 'unknown error';
}
