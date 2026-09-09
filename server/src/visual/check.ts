import path from 'node:path';
import type { FileArtifact, VerificationCheck, VerificationIssue } from '@agentic/core';
import { startStaticServer } from '../staticserver.js';
import { findHtmlFiles } from '../previewdetect.js';
import { profileProject } from '../projects.js';
import { auditUrl } from './renderer.js';
import type { PageAudit } from './renderer.js';
import { describeError, log } from '../log.js';

/**
 * Visual verification: render the page and look at it.
 *
 * This exists because of a specific failure. A run produced a calculator whose
 * CSS grid had a hole in it — one key had been given a span, every key after it
 * had shifted, and the last one sat alone on a row of its own. The syntax gate
 * passed it, the secret scan passed it, the project had no tests to fail, and
 * the task was accepted as verified. The output was visibly, obviously wrong
 * and nothing in the system could see it, because nothing in the system had
 * looked at the page.
 *
 * So: tier 1 asks "does it parse", tier 2 asks "does the project's own suite
 * pass", and this asks "does it render". It sits between them, and it runs
 * against the files as they WOULD be, served from memory, so nothing is written
 * to the working tree before a human accepts it.
 *
 * Two viewports, because a layout that works at one width and collapses at
 * another is the most common defect this catches and a single measurement
 * cannot see it.
 */

/**
 * Widths worth rendering at. Phone first: it is where layouts break.
 *
 * The height is a request rather than a promise. A renderer backed by a real
 * window is clamped by the screen work area and by display scaling, so 844 can
 * come back as 716 — which does not matter, because every check here depends on
 * the WIDTH. What is below the fold is not what makes a layout wrong.
 */
const VIEWPORTS: { width: number; height: number }[] = [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
];

/** Extensions whose change can alter what a page looks like. */
const VISUAL_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.svg']);

export interface VisualCheckOptions {
  projectId: string;
  root: string;
  /** The task's output, not yet applied. Served as an overlay. */
  files: FileArtifact[];
  /** Cap on how long the whole check may take. */
  budgetMs?: number;
}

export interface VisualCheckResult {
  ok: boolean;
  check: VerificationCheck;
  /** Set when there was no way to run it. Never reported as a pass. */
  unavailable?: string;
  /** Every finding, for the review UI. */
  audits: PageAudit[];
}

/** Does this task's output plausibly change what something looks like? */
export function touchesSomethingVisual(files: FileArtifact[]): boolean {
  return files.some((f) => VISUAL_EXTENSIONS.has(path.extname(f.path).toLowerCase()));
}

/**
 * Which page to render.
 *
 * A task that produced an HTML file gets that file. A task that changed only
 * CSS or JavaScript gets the project's entry page, because that is where the
 * change will be seen — a stylesheet on its own renders nothing.
 */
export function pagesToAudit(files: FileArtifact[], root: string): string[] {
  const produced = files
    .map((f) => f.path.split(path.sep).join('/'))
    .filter((p) => /\.html?$/i.test(p));

  if (produced.length) return produced.slice(0, 3);

  // Nothing renderable was produced directly, so find the page that includes it.
  const existing = findHtmlFiles(root);
  return existing.slice(0, 1);
}

export async function runVisualCheck(opts: VisualCheckOptions): Promise<VisualCheckResult> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 45_000;

  const skipped = (reason: string): VisualCheckResult => ({
    ok: true,
    unavailable: reason,
    audits: [],
    check: {
      name: 'Visual',
      ok: false,
      skipped: reason,
      durationMs: Date.now() - started,
      issues: [],
    },
  });

  if (!touchesSomethingVisual(opts.files)) {
    return skipped('Not run: this task produced nothing that changes what a page looks like.');
  }

  /**
   * Only render what a file server can honestly render.
   *
   * This guard exists because its absence destroyed a correct application. A
   * task built an Express login app — package.json, server.js, views/login.html
   * serving `/style.css` out of `public/`. The check served the project as a
   * folder of files, so `/style.css` was a 404, the check called the page
   * broken, and three attempts and the whole task were lost to a defect that
   * was entirely in the check.
   *
   * An app that serves its own pages decides what its URLs mean: static assets
   * are mounted, templates are compiled, routes are not files. Reading its
   * templates off disk answers a question nobody asked. The manual "Check
   * layout" action still covers these projects, because there the app itself is
   * running and the URL is real.
   */
  const profile = profileProject(opts.root);
  if (profile.devServer) {
    return skipped(
      `Not run: this project serves its own pages (\`${profile.devServer.command}\`), so its ` +
        'templates cannot be rendered as plain files. Start the preview and use Check layout ' +
        'to audit the running app.',
    );
  }

  const pages = pagesToAudit(opts.files, opts.root);
  if (!pages.length) {
    return skipped('Not run: this project has no HTML page to render.');
  }

  // The overlay is the whole point: the task's files are served as they would
  // be, and the working tree is not touched.
  const overrides = new Map(opts.files.map((f) => [f.path, f.content]));

  let server;
  try {
    server = await startStaticServer({
      root: opts.root,
      port: await freePort(),
      projectId: opts.projectId,
      overrides,
      // No picker overlay: it adds DOM the audit would then have to reason
      // about, and nothing here needs it.
    });
  } catch (err) {
    return skipped(`Not run: could not serve the project to render it (${describeError(err)}).`);
  }

  const audits: PageAudit[] = [];
  const issues: VerificationIssue[] = [];
  let unavailable: string | undefined;

  try {
    for (const page of pages) {
      for (const viewport of VIEWPORTS) {
        if (Date.now() - started > budgetMs) {
          log('Visual check ran out of time; reporting what it has', 'warn', {
            projectId: opts.projectId,
          });
          break;
        }

        const url = `http://127.0.0.1:${server.port}/${page}`;
        const audit = await auditUrl(url, { width: viewport.width, height: viewport.height });

        if ('unavailable' in audit) {
          unavailable = audit.unavailable;
          break;
        }

        audits.push(audit);
        // The width the page ACTUALLY got, not the one asked for. A repair
        // brief that says "at 390px wide" can be acted on; one that says "on a
        // phone" leaves the agent guessing which phone.
        issues.push(...issuesFrom(audit, page, `${audit.viewport.width}px wide`));
      }
      if (unavailable) break;
    }
  } finally {
    server.close();
  }

  if (unavailable) return skipped(`Not run: ${unavailable}`);

  const errors = issues.filter((i) => i.severity === 'error');

  return {
    ok: errors.length === 0,
    audits,
    check: {
      name: 'Visual',
      ok: errors.length === 0,
      durationMs: Date.now() - started,
      issues: dedupe(issues).slice(0, 25),
      checked: audits.length,
    },
  };
}

/**
 * Turn one page's audit into verification issues.
 *
 * The viewport is named in the message rather than kept as metadata, because a
 * repair prompt that says "at 390px wide" is actionable and one that says
 * "overflow detected" sends the agent looking at the desktop layout.
 */
function issuesFrom(audit: PageAudit, page: string, viewport: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  for (const finding of audit.findings) {
    issues.push({
      file: page,
      source: 'build',
      severity: finding.severity,
      message: `[${viewport}] ${finding.message}${finding.detail ? ` ${finding.detail}` : ''} (${finding.selector})`,
    });
  }

  // A page that threw while loading is broken regardless of how it looks, and
  // this is the only place in the pipeline that can see it happen.
  for (const error of unique(audit.consoleErrors).slice(0, 5)) {
    issues.push({
      file: page,
      source: 'build',
      severity: 'error',
      message: `The page threw while loading: ${error}`,
    });
  }

  for (const failed of unique(audit.failedRequests).slice(0, 5)) {
    // The reload client's own channel is expected to hang open and be cut when
    // the server closes; it is not a defect in the page.
    if (failed.includes('__agentic__/reload')) continue;
    issues.push({
      file: page,
      source: 'build',
      severity: 'error',
      message: `The page asked for something it did not get: ${failed}`,
    });
  }

  return issues;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** The same defect at two viewports is one defect. */
function dedupe(issues: VerificationIssue[]): VerificationIssue[] {
  const seen = new Set<string>();
  const out: VerificationIssue[] = [];
  for (const issue of issues) {
    // Strip the viewport prefix so the two renders collapse onto each other.
    const key = `${issue.file}::${issue.message.replace(/^\[[^\]]+\]\s*/, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/**
 * The repair brief for a visual failure.
 *
 * Written to be acted on rather than acknowledged: the agent cannot see the
 * page, so the text has to carry both the symptom and enough of the mechanism
 * to make the fix obvious.
 */
export function visualFeedback(check: VerificationCheck): string {
  const errors = check.issues.filter((i) => i.severity === 'error');
  const warnings = check.issues.filter((i) => i.severity === 'warning');

  const lines = [
    'The page was rendered in a real browser and it is visibly broken.',
    '',
    'This is not a style opinion. Each of these was measured on the rendered page:',
    '',
    ...errors.map((i) => `- ${i.message}`),
  ];

  if (warnings.length) {
    lines.push('', 'Also worth fixing, though they did not fail the check:', '');
    lines.push(...warnings.map((i) => `- ${i.message}`));
  }

  lines.push(
    '',
    'Fix the layout and emit the complete files again. If a grid is involved, check',
    'every `span` — one spanning item reflows everything after it and leaves a hole.',
    'If the page scrolls sideways, find the element that is wider than its container',
    'rather than hiding the overflow.',
  );

  return lines.join('\n');
}

/** A free port for the throwaway server. Separate range from the preview's. */
async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
