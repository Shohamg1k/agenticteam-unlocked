import type fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens } from '@agentic/core';
import { toRelative } from './paths.js';

/**
 * Code maps.
 *
 * The brief names context as a real constraint, and the naive approach — dump
 * whole files into the prompt — is what makes it one. A code map is the
 * compromise: the *shape* of the repository and the *signatures* in it, at
 * roughly 2% of the tokens of the files themselves.
 *
 * An agent given a code map knows what exists and what it is called. It asks
 * for the files it actually needs, instead of being handed 40 it does not.
 *
 * Symbol extraction is regex-based, not a parser. That is a deliberate trade:
 * a real parser per language would be several dependencies and would still
 * miss languages, whereas a regex that misses an occasional symbol costs an
 * agent one extra file read. The map is a hint, never a contract.
 */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.agentic-team',
  'vendor',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.vue',
  '.svelte',
]);

export interface FileSummary {
  path: string;
  size: number;
  /** Exported or top-level symbols, best-effort. */
  symbols: string[];
  /** Modules this file imports, deduplicated. */
  imports: string[];
}

export interface CodeMap {
  root: string;
  files: FileSummary[];
  /** Directories with a file count, for the tree summary. */
  directories: { path: string; files: number }[];
  totalFiles: number;
  /** True when the walk stopped at the cap; the map is a sample, not a census. */
  truncated: boolean;
  builtAt: number;
}

const MAX_FILES = 1_200;
const MAX_FILE_BYTES = 400_000;

/** Signature-ish declarations. Over-matches slightly; that is the cheap direction. */
const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
  /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm,
  /^\s*class\s+([A-Za-z_]\w*)/gm,
];

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
  /require\(\s*['"]([^'"]+)['"]\s*\)/gm,
  /^\s*from\s+([\w.]+)\s+import/gm,
  /^\s*use\s+([\w:]+)/gm,
];

export async function buildCodeMap(root: string): Promise<CodeMap> {
  const files: FileSummary[] = [];
  const dirCounts = new Map<string, number>();
  let totalFiles = 0;
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (SKIP_DIRS.has(dirent.name) || dirent.name.startsWith('.')) continue;

      const abs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!dirent.isFile()) continue;

      totalFiles++;
      const ext = path.extname(dirent.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) continue;

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = await fsp.readFile(abs, 'utf8');
      } catch {
        continue;
      }

      const rel = toRelative(root, abs);
      files.push({
        path: rel,
        size: stat.size,
        symbols: extract(content, SYMBOL_PATTERNS, 30),
        imports: extract(content, IMPORT_PATTERNS, 20).filter((i) => !i.startsWith('.')),
      });

      const relDir = path.dirname(rel);
      dirCounts.set(relDir, (dirCounts.get(relDir) ?? 0) + 1);
    }
  };

  await walk(root);

  return {
    root,
    files,
    directories: [...dirCounts.entries()]
      .map(([p, count]) => ({ path: p === '.' ? '/' : p, files: count }))
      .sort((a, b) => b.files - a.files),
    totalFiles,
    truncated,
    builtAt: Date.now(),
  };
}

function extract(content: string, patterns: RegExp[], limit: number): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null && found.size < limit) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found];
}

/**
 * Render a code map as prompt text, within a token budget.
 *
 * Ordering matters: directories first (the shape), then the files with the
 * most symbols (the interfaces). Truncating from the bottom therefore drops
 * the least informative entries first.
 */
export function renderCodeMap(map: CodeMap, tokenBudget = 2_000): string {
  const header = [
    '## Repository map',
    '',
    `${map.totalFiles} files total${map.truncated ? ' (map truncated — this is a sample)' : ''}.`,
    '',
    '### Structure',
    ...map.directories.slice(0, 25).map((d) => `- ${d.path} (${d.files} files)`),
    '',
    '### Key files and their exports',
  ];

  const lines = [...header];
  let used = estimateTokens(lines.join('\n'));

  const ranked = [...map.files].sort((a, b) => b.symbols.length - a.symbols.length);
  for (const file of ranked) {
    const line = file.symbols.length
      ? `- ${file.path} — ${file.symbols.slice(0, 12).join(', ')}`
      : `- ${file.path}`;
    const cost = estimateTokens(line);
    if (used + cost > tokenBudget) {
      lines.push(`- ...and ${ranked.length - (lines.length - header.length)} more files`);
      break;
    }
    lines.push(line);
    used += cost;
  }
  return lines.join('\n');
}

/**
 * Files most relevant to a task, ranked by term overlap with the task text.
 *
 * TF-IDF-ish rather than embeddings, on purpose: it is instant, needs no key,
 * works offline, and for "which files does this task mention" it is close to
 * as good. Embeddings are used for the memory store, where semantic distance
 * genuinely matters and the corpus is small.
 */
export function relevantFiles(map: CodeMap, taskText: string, limit = 12): FileSummary[] {
  const terms = tokenize(taskText);
  if (!terms.size) return map.files.slice(0, limit);

  // How many files each term appears in — a term in every file tells us nothing.
  const documentFrequency = new Map<string, number>();
  for (const file of map.files) {
    for (const term of new Set(fileTerms(file))) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const scored = map.files.map((file) => {
    const own = fileTerms(file);
    let score = 0;
    for (const term of terms) {
      const hits = own.filter((t) => t === term).length;
      if (!hits) continue;
      const idf = Math.log(1 + map.files.length / (1 + (documentFrequency.get(term) ?? 0)));
      score += hits * idf;
    }
    // A literal path mention is a much stronger signal than a term match.
    if (taskText.toLowerCase().includes(file.path.toLowerCase())) score += 20;
    return { file, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.file);
}

function fileTerms(file: FileSummary): string[] {
  return [...tokenize(file.path), ...file.symbols.flatMap((s) => [...tokenize(s)])];
}

/** Split on non-word boundaries AND camelCase, so `LoginForm` matches "login". */
function tokenize(text: string): Set<string> {
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 2 && !STOP_WORDS.has(s));
  return new Set(parts);
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'add',
  'use',
  'new',
  'get',
  'set',
  'src',
  'lib',
  'index',
  'test',
  'spec',
  'file',
  'code',
  'make',
  'using',
  'should',
  'must',
  'can',
  'will',
]);
