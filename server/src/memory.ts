import fs from 'node:fs';
import path from 'node:path';
import type { MemoryKind, MemoryNote } from '@agentic/core';
import { rid } from '@agentic/core';
import { ensureDir, projectPaths } from './paths.js';
import { changed, projectState } from './store.js';
import { describeError, log } from './log.js';

/**
 * Shared project memory.
 *
 * One store every agent reads from and writes to: requirements, decisions,
 * architecture, conventions, open bugs. It is what makes a task run by Groq
 * consistent with a task run by Claude Code twenty minutes earlier, and it is
 * what lets any agent resume any task.
 *
 * Stored as Markdown files with YAML-ish front matter (ADR 0003). A human can
 * read the whole memory in a text editor and edit it; `git diff` shows what an
 * agent decided. The search index over it is rebuildable and never canonical.
 */

export const MEMORY_KINDS: MemoryKind[] = [
  'requirement',
  'decision',
  'architecture',
  'convention',
  'task-note',
  'bug',
  'artifact',
];

function memoryFile(root: string, note: MemoryNote): string {
  const slug = note.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return path.join(projectPaths(root).memory, `${note.kind}-${slug || note.id}-${note.id.slice(-6)}.md`);
}

function serialise(note: MemoryNote): string {
  return [
    '---',
    `id: ${note.id}`,
    `kind: ${note.kind}`,
    `title: ${note.title.replace(/\n/g, ' ')}`,
    `tags: ${note.tags.join(', ')}`,
    note.sourceTaskId ? `sourceTaskId: ${note.sourceTaskId}` : '',
    note.sourcePlanId ? `sourcePlanId: ${note.sourcePlanId}` : '',
    `createdAt: ${new Date(note.createdAt).toISOString()}`,
    `updatedAt: ${new Date(note.updatedAt).toISOString()}`,
    '---',
    '',
    note.body.trim(),
    '',
  ]
    .filter((line) => line !== '')
    .join('\n')
    .replace(/^---\n/, '---\n');
}

function parse(content: string, fallbackId: string): MemoryNote | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return null;

  const meta = new Map<string, string>();
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    meta.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }

  const kind = meta.get('kind') as MemoryKind | undefined;
  if (!kind || !MEMORY_KINDS.includes(kind)) return null;

  const parseDate = (v: string | undefined) => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : Date.now();
  };

  return {
    id: meta.get('id') || fallbackId,
    projectId: '',
    kind,
    title: meta.get('title') || 'Untitled',
    body: (match[2] ?? '').trim(),
    tags: (meta.get('tags') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sourceTaskId: meta.get('sourceTaskId') || undefined,
    sourcePlanId: meta.get('sourcePlanId') || undefined,
    createdAt: parseDate(meta.get('createdAt')),
    updatedAt: parseDate(meta.get('updatedAt')),
  };
}

export function loadMemory(projectId: string): MemoryNote[] {
  const ps = projectState(projectId);
  if (!ps) return [];

  const dir = projectPaths(ps.root).memory;
  ensureDir(dir);
  const notes: MemoryNote[] = [];

  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      try {
        const parsed = parse(fs.readFileSync(path.join(dir, name), 'utf8'), rid('mem'));
        if (parsed) notes.push({ ...parsed, projectId });
      } catch (err) {
        log(`Skipped unreadable memory file ${name}: ${describeError(err)}`, 'warn', { projectId });
      }
    }
  } catch {
    // No memory directory yet is the normal state of a new project.
  }

  ps.memory = notes.sort((a, b) => b.updatedAt - a.updatedAt);
  return ps.memory;
}

export function addMemory(
  projectId: string,
  input: {
    kind: MemoryKind;
    title: string;
    body: string;
    tags?: string[];
    sourceTaskId?: string;
    sourcePlanId?: string;
  },
): MemoryNote {
  const ps = projectState(projectId);
  if (!ps) throw new Error(`No such project: ${projectId}`);

  const now = Date.now();
  const note: MemoryNote = {
    id: rid('mem'),
    projectId,
    kind: input.kind,
    title: input.title.trim().slice(0, 200),
    body: input.body.trim(),
    tags: input.tags ?? [],
    sourceTaskId: input.sourceTaskId,
    sourcePlanId: input.sourcePlanId,
    createdAt: now,
    updatedAt: now,
  };

  ensureDir(projectPaths(ps.root).memory);
  fs.writeFileSync(memoryFile(ps.root, note), serialise(note), 'utf8');
  ps.memory.unshift(note);
  changed();
  return note;
}

export function updateMemory(
  projectId: string,
  id: string,
  patch: Partial<Pick<MemoryNote, 'title' | 'body' | 'tags'>>,
): MemoryNote | undefined {
  const ps = projectState(projectId);
  const note = ps?.memory.find((n) => n.id === id);
  if (!ps || !note) return undefined;

  const oldFile = memoryFile(ps.root, note);
  Object.assign(note, patch, { updatedAt: Date.now() });
  const newFile = memoryFile(ps.root, note);

  // The filename encodes the title, so a retitle renames the file. Remove the
  // old one first so a retitle does not leave two copies of one note.
  if (oldFile !== newFile) {
    try {
      fs.rmSync(oldFile, { force: true });
    } catch {
      // Best effort; a stale file is reloaded as a separate note at worst.
    }
  }
  fs.writeFileSync(newFile, serialise(note), 'utf8');
  changed();
  return note;
}

export function deleteMemory(projectId: string, id: string): boolean {
  const ps = projectState(projectId);
  if (!ps) return false;
  const idx = ps.memory.findIndex((n) => n.id === id);
  if (idx < 0) return false;

  const [note] = ps.memory.splice(idx, 1);
  if (note) {
    try {
      fs.rmSync(memoryFile(ps.root, note), { force: true });
    } catch {
      // Removed from the index either way.
    }
  }
  changed();
  return true;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface MemoryHit {
  note: MemoryNote;
  score: number;
}

/**
 * Rank memory notes against a query.
 *
 * BM25-style lexical scoring over a corpus that is typically tens of notes.
 * Deliberately not embeddings by default: an embedding call per search would
 * cost money and a network round-trip on every task, for a corpus small enough
 * that lexical overlap is competitive. Kind and recency weightings do more
 * work here than semantic distance would.
 */
export function searchMemory(projectId: string, query: string, limit = 8, kinds?: MemoryKind[]): MemoryHit[] {
  const ps = projectState(projectId);
  if (!ps) return [];

  const pool = kinds?.length ? ps.memory.filter((n) => kinds.includes(n.kind)) : ps.memory;
  if (!pool.length) return [];

  const queryTerms = terms(query);
  if (!queryTerms.length) return pool.slice(0, limit).map((note) => ({ note, score: 0 }));

  const docs = pool.map((note) => ({
    note,
    terms: terms(`${note.title} ${note.tags.join(' ')} ${note.body}`),
  }));
  const avgLength = docs.reduce((sum, d) => sum + d.terms.length, 0) / docs.length;

  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  // BM25 constants; k1 controls term-frequency saturation, b length normalisation.
  const k1 = 1.5;
  const b = 0.75;
  const now = Date.now();

  const scored = docs.map(({ note, terms: docTerms }) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = docTerms.filter((t) => t === term).length;
      if (!tf) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docTerms.length) / (avgLength || 1))));
    }

    // Decisions and architecture bind future work; a task-note from one run is
    // far less likely to matter to the next. Weight accordingly.
    const kindWeight: Record<MemoryKind, number> = {
      decision: 1.4,
      architecture: 1.4,
      requirement: 1.3,
      convention: 1.25,
      bug: 1.1,
      artifact: 1,
      'task-note': 0.85,
    };
    score *= kindWeight[note.kind];

    // Gentle recency preference: halve the bonus every 14 days.
    const ageDays = (now - note.updatedAt) / 86_400_000;
    score *= 1 + 0.25 * Math.pow(0.5, ageDays / 14);

    return { note, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit);
}

function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 2);
}

/**
 * The always-included memory: decisions, architecture and conventions are the
 * things every task must obey regardless of what it is about. Requirements and
 * bugs are retrieved by relevance instead.
 */
export function bindingMemory(projectId: string, tokenBudget = 1_500): string {
  const ps = projectState(projectId);
  if (!ps?.memory.length) return '';

  const binding = ps.memory
    .filter((n) => n.kind === 'decision' || n.kind === 'architecture' || n.kind === 'convention')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!binding.length) return '';

  const lines: string[] = [
    '## Project decisions and conventions',
    '',
    'These are binding. Do not deviate.',
    '',
  ];
  let used = 60;
  for (const note of binding) {
    const block = `### ${note.title}\n${note.body}\n`;
    const cost = Math.ceil(block.length / 3.7);
    if (used + cost > tokenBudget) break;
    lines.push(block);
    used += cost;
  }
  return lines.join('\n');
}
