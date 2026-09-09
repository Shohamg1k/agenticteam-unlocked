import type { FileArtifact, VerificationIssue } from '@agentic/core';

/**
 * Catch files the model described instead of writing.
 *
 * This exists because of a real run. Asked to build a calculator, the agent
 * replied "Built the calculator as a single self-contained `index.html`",
 * followed by:
 *
 *     FILE: index.html
 *     ```html
 *     [content as written above]
 *     ```
 *
 * There was no content above. Twenty-seven bytes were written to disk, the
 * syntax gate passed them — `[content as written above]` is, unhelpfully, valid
 * enough as HTML — and the task was reported as done and verified. The user's
 * calculator was one line of square brackets.
 *
 * Two things make this worth its own check rather than a regex bolted onto the
 * syntax gate:
 *
 *  - **A parser cannot catch it.** The output is syntactically fine in every
 *    language where prose is legal (HTML, Markdown, plain text), and in the
 *    rest it usually parses as an expression or a comment.
 *  - **It is a whole class, not one phrase.** An elided file, a stub left for
 *    the reader, a "rest unchanged" diff marker and a back-reference to earlier
 *    output are the same failure: the model believed the content existed
 *    somewhere it does not.
 *
 * The check errs strict on phrases no real source file contains, and refuses to
 * guess beyond them. A false positive costs one repair attempt with a clear
 * explanation; a false negative silently ships an empty deliverable, which is
 * the failure that actually happened.
 */

/**
 * Phrases that mean "the content is elsewhere".
 *
 * Every one of these is a phrase that does not appear in working source code.
 * Deliberately not on the list: bare `...`, `TODO`, and `FIXME`. A spread
 * operator, a range and an honest TODO are all normal, and flagging them would
 * make the check something people learn to ignore.
 */
const ELISION_PHRASES: RegExp[] = [
  /\bcontent as (?:written|shown|given) above\b/i,
  /\bas (?:written|shown|provided) above\b/i,
  /\b(?:same|identical) as (?:above|before|the previous)\b/i,
  /\bunchanged from (?:above|before|the original)\b/i,
  /\brest of (?:the )?(?:file|code|implementation)\s*(?:is\s*)?(?:unchanged|omitted|the same)\b/i,
  /\.\.\.\s*rest (?:unchanged|omitted|of it)\b/i,
  /\b(?:omitted|truncated|abbreviated|elided) for brevity\b/i,
  /\b(?:full|entire|complete) (?:file )?contents? (?:go|goes|here|above|below)\b/i,
  /\b(?:the )?(?:implementation|code) (?:continues|goes here)\b/i,
  /\byour code here\b/i,
  /\bsee above for (?:the )?(?:full|complete|actual)\b/i,
  /\bpaste (?:the )?(?:previous|earlier) (?:content|version)\b/i,
  /\bno changes? (?:to this file|needed here)\b/i,
];

/**
 * Echoes of this system's own prompt template.
 *
 * A model that emits `<the entire file contents>` has copied the instruction
 * rather than followed it. Kept separate because the wording is ours, so it
 * must be updated whenever `ARTIFACT_FORMAT_INSTRUCTIONS` changes.
 */
const TEMPLATE_ECHOES: RegExp[] = [
  /^<?the entire file contents>?$/i,
  /^<?file contents?>?$/i,
  /^<?full file>?$/i,
];

/**
 * Below this, a file that mentions an elision is a placeholder rather than a
 * real file that happens to discuss one.
 *
 * A genuine source file long enough to contain the phrase "omitted for brevity"
 * in a comment is almost certainly a real file — documentation, a test fixture,
 * a code sample. Under a few hundred bytes there is nothing else it can be.
 */
const SHORT_FILE_BYTES = 400;

/**
 * A file this short, containing no code at all, is a note to the reader.
 *
 * Length alone is not enough, and the test that proved it was
 * `export const VERSION = '1.4.2';` — thirty-one bytes and a completely
 * legitimate module. So the size check only fires on content that also has no
 * syntax in it: no assignment, no call, no block, no tag, no statement end.
 * `TODO` trips it; a one-line module does not.
 */
const ABSURDLY_SHORT_BYTES = 40;

/** Any of these means the content is code, however little of it there is. */
const LOOKS_LIKE_CODE = /[;={}()<>[\]]|:\s|\b(?:def|fn|func|class|import|return)\b/;

/** Files that are legitimately tiny or empty, and must not be flagged for it. */
const MAY_BE_TINY = new Set([
  '.gitignore',
  '.gitkeep',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.env.example',
  'py.typed',
  '__init__.py',
  'LICENSE',
]);

const TINY_OK_EXTENSIONS = new Set(['.txt', '.md', '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg']);

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? p : p.slice(i + 1);
}

function extension(p: string): string {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/** Strip comment markers and fence noise so a phrase check sees the words. */
function textOf(content: string): string {
  return content
    .replace(/^\s*(?:\/\/|#|--|;|\*|<!--)\s?/gm, '')
    .replace(/-->\s*$/gm, '')
    .replace(/\*\/\s*$/gm, '')
    .trim();
}

export interface PlaceholderFinding {
  path: string;
  /** What was matched, quoted back so the repair prompt can be specific. */
  evidence: string;
  reason: 'elision' | 'template-echo' | 'too-short';
}

/**
 * Find files whose content is a promise of content.
 *
 * Returns findings rather than throwing so the caller can decide: the
 * orchestrator turns them into a failed verification with a repair brief,
 * while a test can assert on them directly.
 */
export function findPlaceholders(files: FileArtifact[]): PlaceholderFinding[] {
  const findings: PlaceholderFinding[] = [];

  for (const file of files) {
    const name = basename(file.path);
    const ext = extension(file.path);
    const body = textOf(file.content);

    // An intentionally-empty marker file is fine, and so is a short note.
    const mayBeTiny = MAY_BE_TINY.has(name) || TINY_OK_EXTENSIONS.has(ext);

    if (!body) {
      if (!mayBeTiny) {
        findings.push({ path: file.path, evidence: '(the file is empty)', reason: 'too-short' });
      }
      continue;
    }

    const echo = TEMPLATE_ECHOES.find((re) => re.test(body));
    if (echo) {
      findings.push({ path: file.path, evidence: body.slice(0, 120), reason: 'template-echo' });
      continue;
    }

    const elision = ELISION_PHRASES.map((re) => re.exec(body)).find(Boolean);
    if (elision && body.length < SHORT_FILE_BYTES) {
      findings.push({ path: file.path, evidence: elision[0], reason: 'elision' });
      continue;
    }

    // A wholly bracketed body — `[...]`, `<...>`, `{...}` — with no newline is
    // a description of a file, not a file. Guarded by length and by the absence
    // of a line break so a real one-line JSON array or JSX fragment survives.
    if (
      body.length < SHORT_FILE_BYTES &&
      !body.includes('\n') &&
      /^[[<(]\s*[a-z][^\n]*[\]>)]$/i.test(body) &&
      ext !== '.json'
    ) {
      findings.push({ path: file.path, evidence: body.slice(0, 120), reason: 'elision' });
      continue;
    }

    if (body.length < ABSURDLY_SHORT_BYTES && !mayBeTiny && !LOOKS_LIKE_CODE.test(body)) {
      findings.push({ path: file.path, evidence: body.slice(0, 120), reason: 'too-short' });
    }
  }

  return findings;
}

/** Findings as verification issues, for the tier-1 report. */
export function placeholderIssues(findings: PlaceholderFinding[]): VerificationIssue[] {
  return findings.map((f) => ({
    file: f.path,
    source: 'syntax' as const,
    severity: 'error' as const,
    message:
      f.reason === 'too-short'
        ? `This file is too short to be the deliverable it claims to be — ${f.evidence}`
        : `This file contains a placeholder instead of its contents: "${f.evidence}"`,
  }));
}

/** The repair brief for a placeholder failure. */
export function placeholderFeedback(findings: PlaceholderFinding[]): string {
  const list = findings.map((f) => `- ${f.path} — ${f.evidence}`).join('\n');
  return [
    'Some of the files you emitted contain a placeholder rather than their contents:',
    '',
    list,
    '',
    'Nothing was applied. Your reply is the only place these files exist — there is no',
    'earlier message to refer back to, and nothing else wrote them to disk. A FILE:',
    'block saying "as written above", "unchanged", or "omitted for brevity" produces an',
    'empty file, which is what happened.',
    '',
    'Emit each of those files again, in full, with every line of real content between',
    'the fences.',
  ].join('\n');
}
