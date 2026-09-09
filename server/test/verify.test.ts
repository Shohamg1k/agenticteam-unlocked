import { describe, expect, it } from 'vitest';
import { repairFeedback, scanForSecrets, verifyArtifacts } from '../src/verify.js';

/**
 * Tier 1: the gate that stops a person being the first to discover a truncated
 * file. It must catch real syntax errors, produce an actionable repair brief,
 * and never fail a file it simply cannot parse.
 */
describe('verifyArtifacts', () => {
  it('passes valid TypeScript', async () => {
    const result = await verifyArtifacts([{ path: 'src/a.ts', content: 'export const a: number = 1;\n' }]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  it('catches a truncated file — the failure this gate exists for', async () => {
    const result = await verifyArtifacts([
      { path: 'src/Login.tsx', content: 'export function Login() {\n  return (\n    <div>\n' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.file).toBe('src/Login.tsx');
    expect(result.issues[0]?.source).toBe('syntax');
  });

  it('reports a line number, which is what makes the repair prompt work', async () => {
    const result = await verifyArtifacts([
      { path: 'src/a.ts', content: 'const a = 1;\nconst b = ;\nconst c = 3;\n' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.line).toBe(2);
  });

  it('catches malformed JSON precisely', async () => {
    const result = await verifyArtifacts([{ path: 'package.json', content: '{ "name": "x",, }' }]);
    expect(result.ok).toBe(false);
  });

  it('accepts valid JSON', async () => {
    const result = await verifyArtifacts([{ path: 'tsconfig.json', content: '{"compilerOptions":{}}' }]);
    expect(result.ok).toBe(true);
  });

  it('skips file types it cannot parse rather than failing them', async () => {
    const result = await verifyArtifacts([
      { path: 'README.md', content: '# Not code {{{' },
      { path: 'logo.svg', content: '<svg><<<' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
    expect(result.skippedCount).toBe(2);
  });

  it('passes trivially when a task produced no files', async () => {
    const result = await verifyArtifacts([]);
    expect(result.ok).toBe(true);
  });

  it('checks every file, not just the first', async () => {
    const result = await verifyArtifacts([
      { path: 'ok.ts', content: 'export const a = 1;' },
      { path: 'bad.ts', content: 'export const = ;' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.file === 'bad.ts')).toBe(true);
  });
});

describe('repairFeedback', () => {
  it('names the file and line, and forbids the shortcuts a model reaches for', async () => {
    const result = await verifyArtifacts([{ path: 'src/a.ts', content: 'function x( {' }]);
    const feedback = repairFeedback(result);

    expect(feedback).toContain('src/a.ts');
    expect(feedback).toContain('REJECTED');
    // Without these, a model "fixes" a syntax error by deleting the file.
    expect(feedback).toMatch(/do not truncate/i);
    expect(feedback).toMatch(/stub/i);
  });
});

describe('scanForSecrets', () => {
  // Built at runtime so this test file never contains a scannable key.
  const fakeKey = (prefix: string, length: number) =>
    prefix + 'A1b2C3d4'.repeat(Math.ceil(length / 8)).slice(0, length);

  it('flags an API key committed to source', () => {
    const issues = scanForSecrets([
      { path: 'src/config.ts', content: `export const key = "${fakeKey('sk-', 40)}";\n` },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('security');
    expect(issues[0]?.message).toMatch(/rotate/i);
  });

  it('flags a GitHub token', () => {
    const issues = scanForSecrets([{ path: '.env', content: `TOKEN=${fakeKey('ghp_', 36)}\n` }]);
    expect(issues).toHaveLength(1);
  });

  it('flags a private key block', () => {
    const issues = scanForSecrets([
      { path: 'deploy/id_rsa', content: '-----BEGIN RSA PRIVATE KEY-----\nabc\n' },
    ]);
    expect(issues).toHaveLength(1);
  });

  it('reports the line number', () => {
    const issues = scanForSecrets([
      { path: 'a.ts', content: `const a = 1;\nconst k = "${fakeKey('sk-', 40)}";\n` },
    ]);
    expect(issues[0]?.line).toBe(2);
  });

  it('ignores placeholders in a .env.example', () => {
    // That file is meant to contain key-shaped strings; flagging it every time
    // would train people to ignore the warning.
    const issues = scanForSecrets([
      { path: '.env.example', content: `OPENAI_API_KEY=${fakeKey('sk-', 40)}\n` },
    ]);
    expect(issues).toEqual([]);
  });

  it('passes ordinary code', () => {
    expect(scanForSecrets([{ path: 'a.ts', content: 'const key = process.env.API_KEY;\n' }])).toEqual([]);
  });
});
