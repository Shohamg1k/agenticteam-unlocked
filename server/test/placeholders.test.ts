import { describe, expect, it } from 'vitest';
import { findPlaceholders, placeholderFeedback } from '../src/placeholders.js';
import type { FileArtifact } from '@agentic/core';

const file = (path: string, content: string): FileArtifact => ({ path, content, language: 'text' });

/**
 * The regression this file exists for, first.
 *
 * A real run produced exactly the artefact in the first test. It passed the
 * syntax gate, was auto-accepted, and became the user's entire application.
 */
describe('the run that motivated this check', () => {
  it('catches the file that shipped as twenty-seven bytes', () => {
    const findings = findPlaceholders([file('index.html', '[content as written above]\n')]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toBe('elision');
    expect(findings[0]!.path).toBe('index.html');
  });

  it('explains the failure in terms the model can act on', () => {
    const feedback = placeholderFeedback(findPlaceholders([file('a.ts', '// same as above\n')]));
    expect(feedback).toContain('a.ts');
    expect(feedback).toContain('there is no');
    expect(feedback.toLowerCase()).toContain('in full');
  });
});

describe('findPlaceholders', () => {
  it('catches the common ways a model refers to content it did not emit', () => {
    const cases = [
      'as written above',
      '// rest of the file unchanged',
      '/* omitted for brevity */',
      '# same as before',
      '<!-- unchanged from above -->',
      'your code here',
      '... rest unchanged',
    ];
    for (const content of cases) {
      const findings = findPlaceholders([file('src/thing.ts', content)]);
      expect(findings, `should have flagged: ${content}`).toHaveLength(1);
    }
  });

  it('catches an echo of our own prompt template', () => {
    const findings = findPlaceholders([file('src/a.ts', '<the entire file contents>')]);
    expect(findings[0]?.reason).toBe('template-echo');
  });

  it('catches an empty file that should have had something in it', () => {
    expect(findPlaceholders([file('src/app.tsx', '   \n\n')])[0]?.reason).toBe('too-short');
  });

  it('catches a bracketed description standing in for a file', () => {
    expect(findPlaceholders([file('index.html', '[the calculator markup]')])).toHaveLength(1);
  });
});

describe('what it must NOT flag', () => {
  it('leaves real code alone, including code that uses ...', () => {
    const real = [
      file('src/a.ts', 'export const merge = (a: object, b: object) => ({ ...a, ...b });\n'),
      file('src/b.py', 'def f(*args, **kwargs):\n    return sum(args)\n'),
      file('src/c.tsx', 'export const List = () => <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;\n'),
    ];
    expect(findPlaceholders(real)).toEqual([]);
  });

  it('leaves a legitimately tiny file alone', () => {
    const tiny = [
      file('.gitignore', 'node_modules\n'),
      file('src/__init__.py', ''),
      file('py.typed', ''),
      file('.nvmrc', '20\n'),
      file('notes.md', 'TBD\n'),
    ];
    expect(findPlaceholders(tiny)).toEqual([]);
  });

  it('does not flag an honest TODO in a real file', () => {
    // A TODO is a normal thing to write. Flagging it would make the check
    // something people learn to ignore, which is worse than not having it.
    const content = [
      'export function parse(input: string): number {',
      '  // TODO: support hexadecimal once the spec settles',
      '  return Number.parseInt(input, 10);',
      '}',
    ].join('\n');
    expect(findPlaceholders([file('src/parse.ts', content)])).toEqual([]);
  });

  it('does not flag a long file that happens to discuss elision', () => {
    // Documentation about this very feature must not trip it.
    const doc = `# Style guide\n\n${'Never write "omitted for brevity" in a source file. '.repeat(20)}`;
    expect(findPlaceholders([file('docs/STYLE.md', doc)])).toEqual([]);
  });

  it('does not flag a compact but complete one-line module', () => {
    expect(findPlaceholders([file('src/version.ts', "export const VERSION = '1.4.2';\n")])).toEqual([]);
  });
});
