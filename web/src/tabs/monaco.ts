import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

/**
 * Monaco setup.
 *
 * Two things matter here:
 *
 *  1. **Monaco is bundled, not loaded from a CDN.** `@monaco-editor/react`
 *     fetches from jsDelivr by default, which would make the editor fail
 *     entirely in a desktop app with no network — and this product's whole
 *     premise is that it works offline apart from the model calls you choose.
 *
 *  2. **Language workers are wired explicitly.** Without this, Monaco falls
 *     back to running language services on the main thread, and typing in a
 *     large TypeScript file janks visibly.
 */

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

/**
 * Editor themes built from the app's CSS variables, so the editor matches the
 * shell in all four themes instead of being an obviously foreign rectangle.
 */
function readVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Monaco wants 6-digit hex; CSS variables may be shorthand or rgb(). */
function toHex(color: string, fallback: string): string {
  const trimmed = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed
      .slice(1)
      .split('')
      .map((c) => c + c)
      .join('')}`;
  }
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(trimmed);
  if (rgb) {
    return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  }
  return fallback;
}

export function defineEditorTheme(): string {
  const bg = toHex(readVar('--bg-app', '#16181d'), '#16181d');
  const fg = toHex(readVar('--fg', '#e4e6eb'), '#e4e6eb');
  const isLight = parseInt(bg.slice(1), 16) > 0x888888;

  const themeName = isLight ? 'agentic-light' : 'agentic-dark';
  monaco.editor.defineTheme(themeName, {
    base: isLight ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': toHex(readVar('--fg-subtle', '#6b7280'), '#6b7280'),
      'editorLineNumber.activeForeground': toHex(readVar('--fg-muted', '#9aa1ae'), '#9aa1ae'),
      'editor.selectionBackground': toHex(readVar('--bg-selected', '#2d3648'), '#2d3648'),
      'editor.lineHighlightBackground': toHex(readVar('--bg-panel', '#1c1f26'), '#1c1f26'),
      'editorCursor.foreground': toHex(readVar('--accent', '#6366f1'), '#6366f1'),
      'editorWidget.background': toHex(readVar('--bg-elevated', '#23262f'), '#23262f'),
      'editorWidget.border': toHex(readVar('--border', '#2a2e38'), '#2a2e38'),
      'editorGutter.background': bg,
      'diffEditor.insertedTextBackground': '#3fb95022',
      'diffEditor.removedTextBackground': '#f8514922',
    },
  });
  monaco.editor.setTheme(themeName);
  return themeName;
}

/** Monaco language id from a file path. */
export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    vue: 'html',
    svelte: 'html',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'cpp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ps1: 'powershell',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    sql: 'sql',
    xml: 'xml',
    svg: 'xml',
    dockerfile: 'dockerfile',
  };
  if (/^dockerfile$/i.test(path.split('/').pop() ?? '')) return 'dockerfile';
  return map[ext] ?? 'plaintext';
}

export { monaco };
