import { describe, expect, it } from 'vitest';
import { extractFiles, languageOf, sanitizeRelPath, undeclaredFiles } from '../src/artifacts.js';

const fence = '```';

describe('sanitizeRelPath', () => {
  it('accepts ordinary relative paths', () => {
    expect(sanitizeRelPath('src/components/Login.tsx')).toBe('src/components/Login.tsx');
    expect(sanitizeRelPath('./src/a.ts')).toBe('src/a.ts');
    expect(sanitizeRelPath('src\\a\\b.ts')).toBe('src/a/b.ts');
  });

  it('keeps dashes, underscores and dots inside a name', () => {
    expect(sanitizeRelPath('src/my-file_name.test.ts')).toBe('src/my-file_name.test.ts');
    expect(sanitizeRelPath('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
  });

  it('rejects traversal', () => {
    expect(sanitizeRelPath('../secrets')).toBeNull();
    expect(sanitizeRelPath('src/../../etc/passwd')).toBeNull();
    expect(sanitizeRelPath('a/./b')).toBeNull();
  });

  it('rejects absolute and drive-letter paths', () => {
    expect(sanitizeRelPath('/etc/passwd')).toBeNull();
    expect(sanitizeRelPath('C:/Windows/System32/x.dll')).toBeNull();
    expect(sanitizeRelPath('c:\\windows\\x')).toBeNull();
    expect(sanitizeRelPath('~/.ssh/id_rsa')).toBeNull();
    expect(sanitizeRelPath('//server/share/x')).toBeNull();
  });

  it('refuses to write inside .git', () => {
    expect(sanitizeRelPath('.git/hooks/pre-commit')).toBeNull();
    expect(sanitizeRelPath('.git/config')).toBeNull();
  });

  it('rejects Windows-reserved device names', () => {
    expect(sanitizeRelPath('con')).toBeNull();
    expect(sanitizeRelPath('src/NUL.txt')).toBeNull();
    expect(sanitizeRelPath('src/COM1')).toBeNull();
    // A name that merely starts with those letters is fine.
    expect(sanitizeRelPath('src/console.ts')).toBe('src/console.ts');
  });

  it('rejects trailing dots, which Windows silently strips', () => {
    expect(sanitizeRelPath('src/file.')).toBeNull();
    expect(sanitizeRelPath('src/dir./file.ts')).toBeNull();
  });

  it('trims surrounding whitespace but rejects it inside the path', () => {
    // Models routinely emit a trailing newline or space after the path; that is
    // noise and is trimmed. A space at the end of an interior segment is a real
    // path that Windows would silently rewrite, so it is refused.
    expect(sanitizeRelPath('  src/file.ts \n')).toBe('src/file.ts');
    expect(sanitizeRelPath('src/dir /file.ts')).toBeNull();
  });

  it('rejects control characters and characters Windows forbids', () => {
    expect(sanitizeRelPath('src/a\u0000b.ts')).toBeNull();
    expect(sanitizeRelPath('src/a\nb.ts')).toBeNull();
    expect(sanitizeRelPath('src/a<b.ts')).toBeNull();
    expect(sanitizeRelPath('src/a|b.ts')).toBeNull();
    expect(sanitizeRelPath('src/a?b.ts')).toBeNull();
  });

  it('rejects empty and overlong paths', () => {
    expect(sanitizeRelPath('')).toBeNull();
    expect(sanitizeRelPath('   ')).toBeNull();
    expect(sanitizeRelPath('a/'.repeat(150))).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(sanitizeRelPath(undefined as unknown as string)).toBeNull();
  });
});

describe('extractFiles', () => {
  it('extracts a single file block', () => {
    const out = `Here you go.

FILE: src/a.ts
${fence}ts
export const a = 1;
${fence}

Done.`;
    expect(extractFiles(out)).toEqual([{ path: 'src/a.ts', content: 'export const a = 1;\n' }]);
  });

  it('extracts several blocks in order', () => {
    const out = `FILE: a.ts
${fence}ts
1
${fence}

FILE: b.ts
${fence}ts
2
${fence}`;
    expect(extractFiles(out).map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('tolerates markdown decoration around the FILE line', () => {
    const out = `### **FILE: \`src/a.ts\`**
${fence}typescript
x
${fence}`;
    expect(extractFiles(out)[0]!.path).toBe('src/a.ts');
  });

  it('accepts a lowercase or Path: label', () => {
    const out = `file: a.ts
${fence}
x
${fence}

Path: b.ts
${fence}
y
${fence}`;
    expect(extractFiles(out).map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('keeps nested fences intact when the outer fence is longer', () => {
    const out = `FILE: README.md
${fence}${fence.slice(0, 1)}md
Some docs with a fence:
${fence}js
const x = 1;
${fence}
More docs.
${fence}${fence.slice(0, 1)}`;
    const files = extractFiles(out);
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toContain('const x = 1;');
    expect(files[0]!.content).toContain('More docs.');
  });

  it('lets a later block replace an earlier one for the same path', () => {
    const out = `FILE: a.ts
${fence}
first
${fence}

Actually, correcting that:

FILE: a.ts
${fence}
second
${fence}`;
    const files = extractFiles(out);
    expect(files).toHaveLength(1);
    expect(files[0]!.content.trim()).toBe('second');
  });

  it('drops blocks whose path is unsafe rather than failing the whole parse', () => {
    const out = `FILE: ../escape.ts
${fence}
bad
${fence}

FILE: ok.ts
${fence}
good
${fence}`;
    expect(extractFiles(out).map((f) => f.path)).toEqual(['ok.ts']);
  });

  it('returns nothing for output with no blocks', () => {
    expect(extractFiles('I recommend refactoring the login flow.')).toEqual([]);
  });

  it('ignores a fenced block with no FILE line', () => {
    expect(extractFiles(`${fence}ts\nconst x = 1;\n${fence}`)).toEqual([]);
  });

  it('handles CRLF output', () => {
    const out = `FILE: a.ts\r\n${fence}ts\r\nconst x = 1;\r\n${fence}\r\n`;
    expect(extractFiles(out)).toHaveLength(1);
  });

  it('is safe to call repeatedly (no leaked regex state)', () => {
    const out = `FILE: a.ts\n${fence}\nx\n${fence}`;
    expect(extractFiles(out)).toHaveLength(1);
    expect(extractFiles(out)).toHaveLength(1);
  });
});

describe('languageOf', () => {
  it('maps known extensions', () => {
    expect(languageOf('src/a.tsx')).toBe('typescript');
    expect(languageOf('a.py')).toBe('python');
  });

  it('falls back to text', () => {
    expect(languageOf('LICENSE')).toBe('text');
    expect(languageOf('a.unknownext')).toBe('text');
  });
});

describe('undeclaredFiles', () => {
  it('is empty when the task declared nothing', () => {
    expect(undeclaredFiles([{ path: 'a.ts', content: '' }], undefined)).toEqual([]);
  });

  it('reports files outside the declared set', () => {
    const produced = [
      { path: 'src/a.ts', content: '' },
      { path: 'src/sneaky.ts', content: '' },
    ];
    expect(undeclaredFiles(produced, ['src/a.ts'])).toEqual(['src/sneaky.ts']);
  });

  it('compares case-insensitively', () => {
    expect(undeclaredFiles([{ path: 'src/a.ts', content: '' }], ['SRC/A.TS'])).toEqual([]);
  });
});
