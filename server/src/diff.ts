import type { DiffHunk, FileDiff } from '@agentic/core';

/**
 * Line diffing and per-hunk application.
 *
 * We compute our own diff rather than parsing `git diff` output, because the
 * review UI's unit of action is a hunk that the user can accept or reject
 * individually — and applying a subset of hunks means reconstructing the file
 * from the ops, which is far more reliable done from a structure we produced
 * than from re-parsing a textual patch.
 */

export type DiffOpKind = 'equal' | 'insert' | 'delete';

export interface DiffOp {
  kind: DiffOpKind;
  /** Index into the `before` lines, for equal and delete. */
  oldIndex: number;
  /** Index into the `after` lines, for equal and insert. */
  newIndex: number;
  text: string;
}

/**
 * Above this many differing lines, Myers' O(ND) stops being worth it and the
 * result stops being reviewable anyway. Past it we emit one replace-everything
 * hunk, which is honest: nobody reviews a 20,000-line diff hunk by hunk.
 */
const MAX_EDIT_DISTANCE = 5_000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  // Keep the split stable across CRLF/LF so a line-ending change alone does not
  // read as "every line changed".
  const normalized = text.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  // A trailing newline produces a final empty element that is not a real line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Myers' greedy diff (the O(ND) variant), with common prefix and suffix trimmed
 * first. Returns ops in file order.
 */
export function diffLines(beforeLines: string[], afterLines: string[]): DiffOp[] {
  // Trim the common prefix and suffix: in a typical agent edit these are most of
  // the file, and removing them turns an expensive diff into a cheap one.
  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start++;
  }
  let endBefore = beforeLines.length;
  let endAfter = afterLines.length;
  while (endBefore > start && endAfter > start && beforeLines[endBefore - 1] === afterLines[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) {
    ops.push({ kind: 'equal', oldIndex: i, newIndex: i, text: beforeLines[i]! });
  }

  const a = beforeLines.slice(start, endBefore);
  const b = afterLines.slice(start, endAfter);
  const middle = a.length + b.length > MAX_EDIT_DISTANCE * 2 ? replaceAll(a, b, start) : myers(a, b, start);
  ops.push(...middle);

  for (let i = endBefore; i < beforeLines.length; i++) {
    ops.push({ kind: 'equal', oldIndex: i, newIndex: i - endBefore + endAfter, text: beforeLines[i]! });
  }
  return ops;
}

function replaceAll(a: string[], b: string[], offset: number): DiffOp[] {
  return [
    ...a.map((text, i) => ({ kind: 'delete' as const, oldIndex: offset + i, newIndex: offset, text })),
    ...b.map((text, i) => ({
      kind: 'insert' as const,
      oldIndex: offset + a.length,
      newIndex: offset + i,
      text,
    })),
  ];
}

function myers(a: string[], b: string[], offset: number): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0)
    return b.map((text, i) => ({ kind: 'insert' as const, oldIndex: offset, newIndex: offset + i, text }));
  if (m === 0)
    return a.map((text, i) => ({ kind: 'delete' as const, oldIndex: offset + i, newIndex: offset, text }));

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const size = 2 * max + 1;
  const v = new Int32Array(size).fill(-1);
  const trace: Int32Array[] = [];
  v[max + 1] = 0;

  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const idx = k + max;
      let x: number;
      if (k === -d || (k !== d && (v[idx - 1] ?? -1) < (v[idx + 1] ?? -1))) {
        x = v[idx + 1] ?? 0;
      } else {
        x = (v[idx - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[idx] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }

  // Past the cap, degrade to a whole-region replacement rather than returning
  // a wrong diff.
  if (found < 0) return replaceAll(a, b, offset);

  // Walk the trace backwards to recover the edit script.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    const idx = k + max;
    const down = k === -d || (k !== d && (prev[idx - 1] ?? -1) < (prev[idx + 1] ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + max] ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: 'equal', oldIndex: offset + x, newIndex: offset + y, text: a[x]! });
    }
    if (d > 0) {
      if (down) {
        y--;
        ops.push({ kind: 'insert', oldIndex: offset + x, newIndex: offset + y, text: b[y]! });
      } else {
        x--;
        ops.push({ kind: 'delete', oldIndex: offset + x, newIndex: offset + y, text: a[x]! });
      }
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: 'equal', oldIndex: offset + x, newIndex: offset + y, text: a[x]! });
  }
  return ops.reverse();
}

// ---------------------------------------------------------------------------
// Hunks
// ---------------------------------------------------------------------------

export const DEFAULT_CONTEXT_LINES = 3;

/**
 * Group ops into hunks with N lines of context. Two changes separated by fewer
 * than 2N equal lines land in one hunk, which is what makes the reviewed unit
 * feel like a coherent edit rather than a shower of one-line fragments.
 */
export function toHunks(before: string, after: string, context = DEFAULT_CONTEXT_LINES): DiffHunk[] {
  const ops = diffLines(splitLines(before), splitLines(after));
  const changedIdx = ops.map((o, i) => (o.kind === 'equal' ? -1 : i)).filter((i) => i >= 0);
  if (!changedIdx.length) return [];

  // Merge nearby changes into ranges.
  const ranges: { start: number; end: number }[] = [];
  for (const i of changedIdx) {
    const last = ranges[ranges.length - 1];
    if (last && i - last.end <= context * 2) last.end = i;
    else ranges.push({ start: i, end: i });
  }

  return ranges.map((range, id) => {
    const from = Math.max(0, range.start - context);
    const to = Math.min(ops.length - 1, range.end + context);
    const slice = ops.slice(from, to + 1);

    const oldLines = slice.filter((o) => o.kind !== 'insert');
    const newLines = slice.filter((o) => o.kind !== 'delete');
    // Unified-diff line numbers are 1-based; an empty side is reported as 0.
    const oldStart = oldLines.length ? oldLines[0]!.oldIndex + 1 : 0;
    const newStart = newLines.length ? newLines[0]!.newIndex + 1 : 0;

    return {
      id,
      header: `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
      oldStart,
      oldLines: oldLines.length,
      newStart,
      newLines: newLines.length,
      lines: slice.map((o) => ({
        kind:
          o.kind === 'equal'
            ? ('context' as const)
            : o.kind === 'insert'
              ? ('add' as const)
              : ('remove' as const),
        text: o.text,
      })),
    };
  });
}

/**
 * Rebuild a file with only the selected hunks applied.
 *
 * Implemented by replaying the op list and, for each op inside a hunk the user
 * rejected, keeping the `before` side instead of the `after` side. Because the
 * ops came from our own diff, this is exact — there is no fuzzy patch matching
 * and no possibility of a hunk applying at the wrong offset.
 */
export function applySelectedHunks(before: string, after: string, selectedHunkIds: number[]): string {
  const selected = new Set(selectedHunkIds);
  const hunks = toHunks(before, after);
  if (!hunks.length) return before;
  if (hunks.every((h) => selected.has(h.id))) return after;
  if (selected.size === 0) return before;

  const ops = diffLines(splitLines(before), splitLines(after));

  // Recompute which op indices belong to which hunk, using the same grouping as
  // toHunks so the ids line up.
  const changedIdx = ops.map((o, i) => (o.kind === 'equal' ? -1 : i)).filter((i) => i >= 0);
  const ranges: { start: number; end: number }[] = [];
  for (const i of changedIdx) {
    const last = ranges[ranges.length - 1];
    if (last && i - last.end <= DEFAULT_CONTEXT_LINES * 2) last.end = i;
    else ranges.push({ start: i, end: i });
  }

  const hunkOf = new Map<number, number>();
  ranges.forEach((range, id) => {
    for (let i = range.start; i <= range.end; i++) hunkOf.set(i, id);
  });

  const out: string[] = [];
  ops.forEach((op, i) => {
    if (op.kind === 'equal') {
      out.push(op.text);
      return;
    }
    const accepted = selected.has(hunkOf.get(i) ?? -1);
    if (op.kind === 'insert' && accepted) out.push(op.text);
    if (op.kind === 'delete' && !accepted) out.push(op.text);
  });

  const trailingNewline = after.endsWith('\n') || before.endsWith('\n');
  return out.join('\n') + (trailingNewline && out.length ? '\n' : '');
}

/** Build a `FileDiff` for the review UI. */
export function fileDiff(
  filePath: string,
  before: string | null,
  after: string | null,
  context = DEFAULT_CONTEXT_LINES,
): FileDiff {
  const status: FileDiff['status'] = before === null ? 'added' : after === null ? 'deleted' : 'modified';
  return {
    path: filePath,
    status,
    hunks: toHunks(before ?? '', after ?? '', context),
    before: before ?? undefined,
    after: after ?? undefined,
  };
}

/** Cheap summary for a badge: how many lines this diff adds and removes. */
export function diffStat(diff: FileDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added++;
      else if (line.kind === 'remove') removed++;
    }
  }
  return { added, removed };
}

/**
 * Heuristic binary detection: a NUL byte in the first 8KB. Same rule git uses,
 * and it keeps the diff viewer from trying to render a PNG as text.
 */
export function looksBinary(content: string): boolean {
  const limit = Math.min(content.length, 8_000);
  for (let i = 0; i < limit; i++) if (content.charCodeAt(i) === 0) return true;
  return false;
}
