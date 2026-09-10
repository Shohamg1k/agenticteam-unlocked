import type { ClarifyingAnswer, ClarifyingQuestion } from '@agentic/core';
import { FAST_PROFILE, rid } from '@agentic/core';
import { getProvider } from './providers/index.js';
import { routePlanner } from './router.js';
import { profileProject } from './projects.js';
import { projectState } from './store.js';
import { buildCodeMap } from './codemap.js';
import { describeError, log } from './log.js';

/**
 * The questions asked between the prompt and the plan.
 *
 * Every ambiguous prompt gets resolved by somebody. Until now that somebody was
 * a model, silently, in the first second of the build — which is how "build me
 * a login page with node" produced a static HTML file, and how a tracker that
 * obviously needed to remember things was built without persistence. Neither
 * was a wrong answer to the prompt as written. Both were the wrong answer to
 * what the person meant, and nobody found out until the thing was finished.
 *
 * Three constraints shaped this, in order:
 *
 *  - **It must be skippable in one click.** A user who does not care must not
 *    be made to care. Every question carries an explicit auto option, and the
 *    whole step has a "just build it" escape that answers all of them at once.
 *  - **It must be fast, or not happen.** The questions are worth roughly five
 *    seconds of the user's time and no more of the machine's. The model call
 *    is capped hard, and anything slower than the cap falls through to a
 *    deterministic set that is still better than not asking.
 *  - **It must ask what actually changes the build.** "What framework" changes
 *    everything. "What should the button say" changes nothing worth a round
 *    trip. Questions that do not change the plan are a tax on the prompt.
 */

/**
 * Hard ceiling on the model call. Past this the questions cost more than they
 * save: a user staring at a spinner to be asked something is worse off than
 * one who was asked nothing.
 */
const BUDGET_MS = 12_000;

export interface ClarifyOptions {
  projectId: string;
  goal: string;
  mode: 'instant' | 'professional';
  signal?: AbortSignal;
}

export async function proposeQuestions(opts: ClarifyOptions): Promise<ClarifyingQuestion[]> {
  const goal = opts.goal.trim();
  if (!goal) return [];

  // A prompt that has already answered the questions should not be asked them.
  // "Add a null check to parseDate" has one reasonable reading; asking about
  // its tech stack is the app being obtuse at somebody who was being clear.
  if (goal.length < 25) return [];

  const brownfield = await isBrownfield(opts.projectId);
  const local = localQuestions(goal, brownfield);

  // Measured, on the provider most people here actually have: a CLI agent
  // takes about nine seconds to answer ANYTHING, because that is what starting
  // the process and authenticating costs before a token is generated. Nine
  // seconds of nothing, to be handed a question, is a worse product than the
  // instant one below — and this whole feature only earns its place by being
  // cheap. So a process-spawned provider is not asked.
  //
  // An HTTP provider answers in about two, which is inside what a person will
  // sit through, and its questions are genuinely better: it reads the actual
  // sentence rather than matching words in it.
  if (!worthAsking(opts.projectId, goal, opts.mode)) return local;

  try {
    const asked = await withTimeout(askModel({ ...opts, goal, brownfield }), BUDGET_MS, opts.signal);
    if (asked?.length) return asked.slice(0, 3);
  } catch (err) {
    log(`Could not generate clarifying questions: ${describeError(err)}`, 'info', {
      projectId: opts.projectId,
    });
  }

  return local;
}

/** Is there a provider that can answer fast enough to be worth waiting for? */
function worthAsking(projectId: string, goal: string, mode: 'instant' | 'professional'): boolean {
  const chosen = routePlanner(projectId, goal, 1_000, mode).chosen;
  return chosen?.kind !== undefined && getProvider(chosen.providerId)?.transport === 'http';
}

/**
 * Fold the answers into the goal.
 *
 * They go in as decisions rather than as a transcript, because the planner is
 * not being told about a conversation — it is being told what has already been
 * settled, and anything phrased as a discussion invites it to reopen one.
 */
export function applyAnswers(goal: string, answers: ClarifyingAnswer[]): string {
  const real = answers.filter((a) => a.answer.trim() && !isAuto(a.answer));
  if (!real.length) return goal;

  return [
    goal.trim(),
    '',
    'The user was asked about the ambiguous parts of this and answered:',
    ...real.map((a) => `- ${a.question} -> ${a.answer}`),
    '',
    'These are settled. Build to them rather than reconsidering them.',
  ].join('\n');
}

const isAuto = (answer: string) => /^(auto|you decide|whatever|no preference)\b/i.test(answer.trim());

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

async function askModel(
  opts: ClarifyOptions & { goal: string; brownfield: string | undefined },
): Promise<ClarifyingQuestion[] | undefined> {
  const ps = projectState(opts.projectId);
  if (!ps) return undefined;

  const prompt = [
    'A user asked an AI engineering team to build this:',
    '',
    opts.goal,
    '',
    opts.brownfield ?? 'The project folder is empty — this is a greenfield build.',
    '',
    'Ask AT MOST 3 questions whose answers would change what gets built. Fewer is',
    'better, and none is the right answer for a prompt that is already specific.',
    '',
    'Ask about, when the prompt leaves it open:',
    '- The stack, when a greenfield build could reasonably be several things.',
    '- Scope: the smallest useful version, or the full thing with accounts and persistence.',
    '- Where the data lives, when the thing obviously holds data.',
    '- Anything else where two reasonable readings produce different software.',
    '',
    'Never ask:',
    '- Something the prompt already says.',
    '- Something you would decide the same way regardless of the answer.',
    '- A matter of taste that does not change the code — copy, a colour, a name.',
    '- Anything answerable by looking at the project, when there is one.',
    '',
    'Each question gets 2-4 concrete options. Real, specific choices — "React + Vite"',
    'not "a modern framework". The LAST option of every question is always the',
    'sensible default, phrased as "Auto — <what you would pick and why, in a few',
    'words>", so someone who does not care can accept your judgement in one click.',
    '',
    'Return ONE JSON object, no prose, no code fence:',
    '',
    '{"questions":[{"header":"Tech stack","question":"...?","options":[' +
      '{"label":"React + Vite","detail":"what this means for the build"},' +
      '{"label":"Auto — plain HTML/CSS/JS, fastest to a working page"}]}]}',
    '',
    'Return {"questions":[]} if the prompt genuinely needs nothing clarified.',
  ].join('\n');

  const decision = routePlanner(opts.projectId, opts.goal, Math.ceil(prompt.length / 3.7), opts.mode);
  const chosen = decision.chosen;
  const adapter = chosen && getProvider(chosen.providerId);
  if (!adapter || !chosen) return undefined;

  const controller = new AbortController();
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let text = '';
  for await (const event of adapter.stream(
    {
      runId: `clarify_${Date.now().toString(36)}`,
      model: chosen.model.id,
      system:
        'You work out what a build request leaves ambiguous. You ask few questions and only ones ' +
        'whose answers change the software. You always reply with a single valid JSON object.',
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 1_500,
      cwd: ps.root,
      // No tool loop and no exploring: this is one short call whose entire job
      // is to read a sentence and have an opinion about it.
      profile: { ...FAST_PROFILE, maxOutputTokens: 1_500, maxContextTokens: 8_000, maxAttempts: 1 },
    },
    controller.signal,
  )) {
    if (event.type === 'delta') text += event.text;
    else if (event.type === 'done') {
      text = event.text || text;
      adapter.recordUsage(event.usage);
    } else if (event.type === 'error') return undefined;
  }

  return parseQuestions(text);
}

export function parseQuestions(text: string): ClarifyingQuestion[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  const raw = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];

  const out: ClarifyingQuestion[] = [];
  for (const item of raw.slice(0, 3)) {
    const q = item as { header?: unknown; question?: unknown; options?: unknown };
    const question = typeof q.question === 'string' ? q.question.trim() : '';
    if (!question) continue;

    const options: ClarifyingQuestion['options'] = [];
    for (const o of Array.isArray(q.options) ? q.options.slice(0, 4) : []) {
      const opt = o as { label?: unknown; detail?: unknown };
      const label = typeof opt.label === 'string' ? opt.label.trim() : '';
      if (!label) continue;
      options.push({
        id: rid('opt'),
        label,
        detail: typeof opt.detail === 'string' ? opt.detail.trim() || undefined : undefined,
      });
    }
    // A question with one option is not a question. Two is the minimum that
    // asks the user anything, and a model that returns fewer has misunderstood
    // the job rather than found a genuinely one-sided choice.
    if (options.length < 2) continue;

    out.push({
      id: rid('q'),
      header: typeof q.header === 'string' && q.header.trim() ? q.header.trim().slice(0, 24) : 'Choice',
      question,
      options,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The questions we can ask without a model
// ---------------------------------------------------------------------------

/**
 * Named stacks, so the app never asks about something the prompt already said.
 *
 * "build it html css and js" is the end of the stack conversation. Asking
 * anyway is the app admitting it did not read the sentence, and it is the
 * fastest way to make a useful step feel like a form.
 */
const STACK_WORDS =
  /\b(html|css|vanilla|react|vue|svelte|angular|next\.?js|nuxt|remix|astro|node|express|fastify|nest|django|flask|fastapi|rails|laravel|spring|mern|mean|mongo|postgres|mysql|sqlite|supabase|firebase|prisma|typescript|python|go\b|rust|java\b|php|tailwind|bootstrap)/i;

/** Things that plainly hold data a person would expect to still be there. */
const HOLDS_DATA =
  /\b(track|tracker|list|todo|task|note|save|saved|log|record|manage|calendar|schedul|inventory|budget|expense|habit|journal|bookmark|contact|recipe|library|collection)/i;

/** Things that plainly involve people signing in. */
const HAS_ACCOUNTS = /\b(login|log in|sign ?in|sign ?up|account|auth|user|password|register|profile)/i;

/**
 * What to ask when no model is worth waiting for — which, on a CLI provider, is
 * always.
 *
 * These are not filler. Every question here is one of the failures that
 * actually happened: a login page asked for "with node" was built as a static
 * HTML file, and a tracker was built with no persistence, so everything typed
 * into it vanished on refresh. Both were reasonable readings of the prompt.
 * Neither was what the person meant, and in both cases nobody had been asked.
 *
 * The rule that keeps it from being annoying is that a question is only asked
 * when the prompt genuinely left it open. A prompt that names its stack is not
 * asked about its stack.
 */
export function localQuestions(goal: string, brownfield: string | undefined): ClarifyingQuestion[] {
  const questions: ClarifyingQuestion[] = [];

  // The stack is settled by an existing project, or by the user saying it.
  if (!brownfield && !STACK_WORDS.test(goal)) {
    questions.push({
      id: rid('q'),
      header: 'Tech stack',
      question: 'What should this be built with?',
      options: [
        {
          id: rid('opt'),
          label: 'Plain HTML, CSS and JavaScript',
          detail: 'No build step. Opens in a browser the moment it is written.',
        },
        {
          id: rid('opt'),
          label: 'React + Vite',
          detail: 'A dev server and components. Better once there is real state to manage.',
        },
        {
          id: rid('opt'),
          label: 'Full stack — React, Node/Express and a database',
          detail: 'For accounts, shared data or an API. Slower to first run.',
        },
        {
          id: rid('opt'),
          label: 'Auto — whatever fits what I asked for',
          detail: 'The planner decides from the request.',
        },
      ],
    });
  }

  // Only worth asking when the thing obviously holds data AND the prompt has
  // not already said where it goes.
  if (HOLDS_DATA.test(goal) && !/\b(mongo|postgres|mysql|sqlite|supabase|firebase|database|db\b)/i.test(goal)) {
    questions.push({
      id: rid('q'),
      header: 'Data',
      question: 'Where should the data live?',
      options: [
        {
          id: rid('opt'),
          label: 'In the browser',
          detail: 'Survives a refresh, stays on this machine. No backend, nothing to run.',
        },
        {
          id: rid('opt'),
          label: 'A real database',
          detail: 'Shared across devices and browsers. Adds a server and setup.',
        },
        {
          id: rid('opt'),
          label: 'Auto — in the browser unless it needs more',
          detail: 'Whatever the feature actually requires.',
        },
      ],
    });
  }

  if (HAS_ACCOUNTS.test(goal) && questions.length < 3) {
    questions.push({
      id: rid('q'),
      header: 'Accounts',
      question: 'How real should sign-in be?',
      options: [
        {
          id: rid('opt'),
          label: 'The screens only',
          detail: 'Forms, validation and states. Nothing is actually authenticated.',
        },
        {
          id: rid('opt'),
          label: 'Working accounts',
          detail: 'Real sign-up, hashed passwords, sessions. A backend comes with it.',
        },
        {
          id: rid('opt'),
          label: 'Auto — working, kept simple',
          detail: 'Real authentication without a provider or a password reset flow.',
        },
      ],
    });
  }

  if (questions.length < 3) {
    questions.push({
      id: rid('q'),
      header: 'Scope',
      question: 'How far should this go in the first build?',
      options: [
        {
          id: rid('opt'),
          label: 'The smallest thing that works',
          detail: 'One screen, the core flow, finished properly.',
        },
        {
          id: rid('opt'),
          label: 'The full feature',
          detail: 'Every state and edge case you would expect to find.',
        },
        {
          id: rid('opt'),
          label: 'Auto — the full feature, kept tight',
          detail: 'Complete, without inventing scope you did not ask for.',
        },
      ],
    });
  }

  return questions.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isBrownfield(projectId: string): Promise<string | undefined> {
  const ps = projectState(projectId);
  if (!ps) return undefined;

  const map = await buildCodeMap(ps.root).catch(() => undefined);
  if (!map?.totalFiles) return undefined;

  const profile = profileProject(ps.root);
  const frameworks = profile.frameworks.length ? `, using ${profile.frameworks.join(', ')}` : '';
  return (
    `The project already exists: ${map.totalFiles} file(s), ${profile.ecosystem}${frameworks}. ` +
    'Do not ask about the stack — it is already decided.'
  );
}

function withTimeout<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => resolve(undefined), { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
