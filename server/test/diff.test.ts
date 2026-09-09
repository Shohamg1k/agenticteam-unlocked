import { describe, expect, it } from 'vitest';
import {
  applySelectedHunks,
  diffLines,
  diffStat,
  fileDiff,
  looksBinary,
  splitLines,
  toHunks,
} from '../src/diff.js';

const lines = (s: string) => splitLines(s);

describe('splitLines', () => {
  it('handles the empty string', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('drops the phantom line after a trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });

  it('normalises CRLF so a line-ending change is not a whole-file diff', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(diffLines(lines('a\r\nb\r\n'), lines('a\nb\n')).every((o) => o.kind === 'equal')).toBe(true);
  });
});

describe('diffLines', () => {
  it('reports every line equal for identical input', () => {
    const ops = diffLines(lines('a\nb\nc'), lines('a\nb\nc'));
    expect(ops.map((o) => o.kind)).toEqual(['equal', 'equal', 'equal']);
  });

  it('reconstructs the new file from equal + insert ops', () => {
    const before = 'one\ntwo\nthree\nfour';
    const after = 'one\nTWO\nthree\nfour\nfive';
    const ops = diffLines(lines(before), lines(after));
    const rebuilt = ops
      .filter((o) => o.kind !== 'delete')
      .map((o) => o.text)
      .join('\n');
    expect(rebuilt).toBe(after);
  });

  it('reconstructs the old file from equal + delete ops', () => {
    const before = 'one\ntwo\nthree';
    const after = 'one\nthree\nfour';
    const ops = diffLines(lines(before), lines(after));
    const rebuilt = ops
      .filter((o) => o.kind !== 'insert')
      .map((o) => o.text)
      .join('\n');
    expect(rebuilt).toBe(before);
  });

  it('handles an empty before (a new file)', () => {
    const ops = diffLines([], lines('a\nb'));
    expect(ops.every((o) => o.kind === 'insert')).toBe(true);
    expect(ops).toHaveLength(2);
  });

  it('handles an empty after (a deleted file)', () => {
    const ops = diffLines(lines('a\nb'), []);
    expect(ops.every((o) => o.kind === 'delete')).toBe(true);
  });

  it('handles both sides empty', () => {
    expect(diffLines([], [])).toEqual([]);
  });

  it('finds a minimal edit in a large mostly-unchanged file', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 1000', 'line 1000 CHANGED');
    const ops = diffLines(lines(before), lines(after));
    expect(ops.filter((o) => o.kind !== 'equal')).toHaveLength(2); // one delete, one insert
  });
});

describe('toHunks', () => {
  it('returns nothing when the files match', () => {
    expect(toHunks('a\nb', 'a\nb')).toEqual([]);
  });

  it('produces one hunk for one localised change', () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l20', 'l20-changed');
    const hunks = toHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines.some((l) => l.text === 'l20-changed' && l.kind === 'add')).toBe(true);
  });

  it('produces separate hunks for changes far apart', () => {
    const before = Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l5', 'A').replace('l50', 'B');
    expect(toHunks(before, after)).toHaveLength(2);
  });

  it('merges changes closer together than twice the context', () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'A').replace('l12', 'B');
    expect(toHunks(before, after)).toHaveLength(1);
  });

  it('numbers hunks from zero, in file order', () => {
    const before = Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l5', 'A').replace('l50', 'B');
    expect(toHunks(before, after).map((h) => h.id)).toEqual([0, 1]);
  });

  it('emits a unified-style header with 1-based line numbers', () => {
    const hunks = toHunks('a\nb\nc', 'a\nX\nc');
    expect(hunks[0]!.header).toMatch(/^@@ -1,3 \+1,3 @@$/);
    expect(hunks[0]!.oldStart).toBe(1);
  });
});

describe('applySelectedHunks', () => {
  const before = Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n');
  const after = before.replace('l5', 'AAA').replace('l50', 'BBB');

  it('accepting every hunk yields the new file exactly', () => {
    const hunks = toHunks(before, after);
    expect(
      applySelectedHunks(
        before,
        after,
        hunks.map((h) => h.id),
      ),
    ).toBe(after);
  });

  it('accepting no hunk yields the old file exactly', () => {
    expect(applySelectedHunks(before, after, [])).toBe(before);
  });

  it('accepting one hunk applies only that change', () => {
    const result = applySelectedHunks(before, after, [0]);
    expect(result).toContain('AAA');
    expect(result).not.toContain('BBB');
    expect(result).toContain('l50');
  });

  it('accepting the second hunk applies only that change', () => {
    const result = applySelectedHunks(before, after, [1]);
    expect(result).not.toContain('AAA');
    expect(result).toContain('BBB');
    expect(result).toContain('l5');
  });

  it('keeps the line count right when a hunk adds lines', () => {
    const b = 'a\nb\nc';
    const a = 'a\nb\nb2\nc';
    expect(applySelectedHunks(b, a, [0])).toBe(a);
    expect(applySelectedHunks(b, a, [])).toBe(b);
  });

  it('keeps the line count right when a hunk removes lines', () => {
    const b = 'a\nb\nc\nd';
    const a = 'a\nd';
    expect(applySelectedHunks(b, a, [0])).toBe(a);
    expect(applySelectedHunks(b, a, [])).toBe(b);
  });

  it('handles a brand new file', () => {
    expect(applySelectedHunks('', 'hello\n', [0])).toBe('hello\n');
    expect(applySelectedHunks('', 'hello\n', [])).toBe('');
  });

  it('preserves a trailing newline', () => {
    expect(applySelectedHunks('a\nb\n', 'a\nX\n', [0]).endsWith('\n')).toBe(true);
  });

  it('is a no-op when the files are identical', () => {
    expect(applySelectedHunks('same', 'same', [0])).toBe('same');
  });
});

describe('fileDiff', () => {
  it('marks a new file added', () => {
    expect(fileDiff('a.ts', null, 'x').status).toBe('added');
  });

  it('marks a removed file deleted', () => {
    expect(fileDiff('a.ts', 'x', null).status).toBe('deleted');
  });

  it('marks a changed file modified', () => {
    expect(fileDiff('a.ts', 'x', 'y').status).toBe('modified');
  });
});

describe('diffStat', () => {
  it('counts added and removed lines', () => {
    const stat = diffStat(fileDiff('a.ts', 'a\nb\nc', 'a\nX\nY\nc'));
    expect(stat).toEqual({ added: 2, removed: 1 });
  });
});

describe('looksBinary', () => {
  it('detects a NUL byte', () => {
    expect(looksBinary(`abc${String.fromCharCode(0)}def`)).toBe(true);
  });

  it('passes ordinary text', () => {
    expect(looksBinary('const x = 1;\n')).toBe(false);
  });
});
