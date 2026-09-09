/// <reference types="vite/client" />

/**
 * The desktop bridge.
 *
 * The Electron preload exposes exactly these, and nothing else. The renderer
 * has no Node integration: everything privileged goes through the local core
 * service over HTTP, and this bridge covers only what a browser genuinely
 * cannot do — a native folder picker and window controls.
 *
 * It is optional throughout, so the same build runs in a plain browser with
 * those features degraded rather than broken.
 */
interface AgenticBridge {
  /** Native folder picker. Resolves to an absolute path, or null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** Reveal a path in Explorer/Finder. */
  showItemInFolder?(path: string): void;
  /** Open a URL in the user's real browser rather than inside the app. */
  openExternal?(url: string): void;
  platform?: NodeJS.Platform;
  version?: string;
}

interface Window {
  agentic?: AgenticBridge;
}
