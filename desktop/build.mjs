import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

/**
 * Bundle the Electron main process and preload.
 *
 * esbuild rather than tsc because both entry points must be CommonJS —
 * Electron's main process and preload do not load ESM — while the rest of the
 * repo is ESM. Bundling also flattens the `@agentic/server` import so the
 * packaged app does not need a resolvable workspace layout at runtime.
 *
 * The native modules stay external: they are loaded from `node_modules` at
 * runtime (unpacked from the asar, see the `asarUnpack` config), because a
 * `.node` binary cannot be bundled into JavaScript.
 *
 * The two entry points get DIFFERENT settings, and that distinction is the
 * whole reason this file is not a one-liner — see below.
 */

rmSync('dist', { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: [
    'electron',
    'node-pty',
    '@napi-rs/keyring',
    'esbuild',
    // Optional deps of ws that it feature-detects at runtime; bundling them
    // turns a soft "not installed" into a hard build error.
    'bufferutil',
    'utf-8-validate',
  ],
};

/**
 * The MAIN process only.
 *
 * The server is ESM and uses `import.meta.url` to find its own directory.
 * Electron's main process is CommonJS, where `import.meta` is empty — so
 * without this, `fileURLToPath(import.meta.url)` throws the moment the server
 * module loads and the app dies before it draws a window.
 *
 * Mapping it to the CJS `__filename` as a file URL is exact: every use of it in
 * the server is `path.dirname(fileURLToPath(import.meta.url))`, which yields
 * the bundle's own directory — where the build puts the preview overlay it
 * needs to read.
 *
 * This must NOT be applied to the preload. A sandboxed preload has no
 * `__filename` and may only `require('electron')`, so the shim throws on its
 * first line, the whole preload never runs, and `window.agentic` is silently
 * undefined — which looks to a user like "Open a folder does nothing", with no
 * error anywhere they would think to look. `scripts/check-preload.mjs` exists
 * to catch exactly that.
 */
await build({
  ...shared,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  define: { 'import.meta.url': '__agenticModuleUrl' },
  inject: ['./module-url-shim.mjs'],
});

/**
 * The PRELOAD.
 *
 * Deliberately plain: no injected shim, no Node builtins, nothing but
 * `require('electron')`. It runs sandboxed, and everything else is unavailable
 * there.
 */
await build({
  ...shared,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
});

/**
 * The IPC surface, emitted separately as well as bundled into main.
 *
 * `scripts/check-open-folder.mjs` registers the REAL handlers rather than a
 * copy of them — a check that tests a reimplementation of the thing it is
 * checking is worth nothing.
 */
await build({
  ...shared,
  entryPoints: ['src/ipc.ts'],
  outfile: 'dist/ipc.cjs',
});

/**
 * The preview overlay is read from disk at runtime, not bundled — it is
 * injected into the user's page as a string, so it must stay a real file.
 * The server looks for it next to its own `__dirname`, which in the bundled
 * app is `desktop/dist`, so it is copied here.
 */
mkdirSync('dist/public', { recursive: true });
cpSync('../server/public', 'dist/public', { recursive: true });

console.log('[desktop] main.cjs, preload.cjs and the preview overlay are built');
