/**
 * @agentic/core — the contracts every other package agrees on.
 *
 * Nothing here does I/O, spawns a process, or knows a provider exists. That
 * keeps it trivially testable and keeps provider-specific logic where it
 * belongs: inside a single adapter file.
 */

export * from './types.js';
export * from './provider.js';
export * from './taskgraph.js';
export * from './routing.js';
export * from './artifacts.js';
export * from './roles.js';
export * from './profiles.js';
export * from './ids.js';
export * from './protocol.js';
