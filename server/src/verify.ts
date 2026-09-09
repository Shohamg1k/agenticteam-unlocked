import type { FileArtifact, VerificationCheck, VerificationIssue } from '@agentic/core';

/**
 * Tier 1 verification: does every produced file parse?
 *
 * This is the gate that stops a human being the first thing to discover that a
 * model truncated a file. It is deliberately syntax-level:
 *
 *  - it needs no project config, no install, and no network, so it applies to
 *    every task on every project from the very first run;
 *  - it never touches the user's repo — it parses strings in memory;
 *  - when it fails it produces the REAL parser error, with file and line, which
 *    is what makes the single auto-repair attempt actually work. A repair
 *    prompt saying "it didn't compile" changes nothing; one saying
 *    "Login.tsx:88 Unexpected end of file" changes everything.
 *
 * Running the project's own typecheck and tests is tier 2 (projectchecks.ts).
 */

const MAX_FILES = 60;
const MAX_BYTES = 500_000;

type Loader = 'ts' | 'tsx' | 'js' | 'jsx' | 'css' | 'json';

/** esbuild loader for an extension, or undefined when we cannot check it. */
function loaderFor(file: string): Loader | undefined {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.jsx':
      return 'jsx';
    case '.css':
      return 'css';
    case '.json':
      return 'json';
    default:
      return undefined;
  }
}

/** A tier-1 result always carries its counts; the base type has them optional. */
export interface Tier1Result extends VerificationCheck {
  checked: number;
  skippedCount: number;
}

export async function verifyArtifacts(files: FileArtifact[]): Promise<Tier1Result> {
  const started = Date.now();
  const subset = files.slice(0, MAX_FILES);
  const issues: VerificationIssue[] = [];
  let checked = 0;
  let skippedCount = 0;

  for (const file of subset) {
    const loader = loaderFor(file.path);
    if (!loader || file.content.length > MAX_BYTES) {
      skippedCount++;
      continue;
    }
    checked++;
    issues.push(...(await parseOne(file, loader)));
  }

  return {
    name: 'Syntax',
    ok: issues.length === 0,
    durationMs: Date.now() - started,
    issues: issues.slice(0, 25),
    checked,
    skippedCount,
  };
}

async function parseOne(file: FileArtifact, loader: Loader): Promise<VerificationIssue[]> {
  // JSON has a precise native parser; esbuild is tolerant of some malformed
  // JSON that would then break at runtime.
  if (loader === 'json') {
    try {
      JSON.parse(file.content);
      return [];
    } catch (err) {
      return [
        {
          file: file.path,
          message: String((err as Error)?.message ?? err).slice(0, 300),
          source: 'syntax',
          severity: 'error',
        },
      ];
    }
  }

  try {
    const esbuild = await import('esbuild');
    await esbuild.transform(file.content, { loader, sourcefile: file.path });
    return [];
  } catch (err) {
    const errors = (err as { errors?: { text?: string; location?: { line?: number; column?: number } }[] })
      .errors;
    if (!errors?.length) {
      return [
        {
          file: file.path,
          message: String((err as Error)?.message ?? err).slice(0, 300),
          source: 'syntax',
          severity: 'error',
        },
      ];
    }
    return errors.slice(0, 5).map((e) => ({
      file: file.path,
      line: e.location?.line,
      column: e.location?.column,
      message: String(e.text ?? 'Syntax error').slice(0, 300),
      source: 'syntax' as const,
      severity: 'error' as const,
    }));
  }
}

/**
 * The repair brief handed back to the model.
 *
 * Specific, and explicit about the failure modes a model reaches for when told
 * its code does not compile: deleting the file, stubbing it out, or emitting a
 * fragment. All three "fix" the error and destroy the work.
 */
export function repairFeedback(result: Tier1Result): string {
  const lines = result.issues.map(
    (i) => `- ${i.file}${i.line ? `:${i.line}${i.column != null ? `:${i.column}` : ''}` : ''} — ${i.message}`,
  );
  return [
    `Automated verification REJECTED your output: ${result.issues.length} syntax error(s) across ${result.checked} file(s).`,
    '',
    ...lines,
    '',
    'These files do not parse, so they cannot run.',
    '',
    'Re-emit the COMPLETE corrected file(s) in the same FILE: + fenced-block format.',
    'Fix the actual syntax error. Do not truncate the file, do not replace the body with a stub,',
    'and do not drop the file to avoid the error — any of those fails the gate again.',
  ].join('\n');
}

/**
 * Cheap secret scan over produced files.
 *
 * Runs alongside tier 1 because a committed key is the one defect where
 * catching it after the fact is materially worse than catching it before: the
 * remedy is rotating the credential, not editing the file.
 */
export function scanForSecrets(files: FileArtifact[]): VerificationIssue[] {
  const patterns: { re: RegExp; what: string }[] = [
    { re: /\bsk-[A-Za-z0-9_-]{20,}/g, what: 'an API key' },
    { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, what: 'a GitHub token' },
    { re: /\bAIza[A-Za-z0-9_-]{30,}/g, what: 'a Google API key' },
    { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, what: 'a Slack token' },
    { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, what: 'a private key' },
    { re: /\baws_secret_access_key\s*=\s*\S{20,}/gi, what: 'an AWS secret' },
  ];

  const issues: VerificationIssue[] = [];
  for (const file of files) {
    // A .env.example full of placeholders is the intended shape of that file.
    if (/\.env\.(example|sample|template)$/.test(file.path)) continue;

    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { re, what } of patterns) {
        re.lastIndex = 0;
        if (re.test(lines[i]!)) {
          issues.push({
            file: file.path,
            line: i + 1,
            message: `Looks like ${what} committed to source. Move it to an environment variable and rotate the credential.`,
            source: 'security',
            severity: 'error',
          });
          break;
        }
      }
    }
  }
  return issues;
}
