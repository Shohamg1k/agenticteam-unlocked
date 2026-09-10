import { describe, expect, it } from 'vitest';
import { applyAnswers, localQuestions, parseQuestions } from '../src/clarify.js';

/**
 * The step between the prompt and the plan.
 *
 * Two failures put it there. "Build me a login page with node" was built as a
 * static HTML file — a defensible reading of the sentence, and not what the
 * person meant. A calendar tracker was built with no persistence, so everything
 * typed into it vanished on refresh; nobody had said it should not, and nobody
 * had been asked.
 *
 * What is tested here is mostly the refusal to be annoying. The questions are
 * only worth showing if they can be ignored for free, so every path that could
 * turn them into a form the user must fill in is pinned down.
 */

describe('parsing what the model asked', () => {
  it('takes a well-formed set of questions', () => {
    const questions = parseQuestions(
      JSON.stringify({
        questions: [
          {
            header: 'Tech stack',
            question: 'What should this be built with?',
            options: [
              { label: 'React + Vite', detail: 'A dev server and components.' },
              { label: 'Auto — plain HTML, fastest to a working page' },
            ],
          },
        ],
      }),
    );

    expect(questions).toHaveLength(1);
    expect(questions[0]!.question).toBe('What should this be built with?');
    expect(questions[0]!.options.map((o) => o.label)).toEqual([
      'React + Vite',
      'Auto — plain HTML, fastest to a working page',
    ]);
    // Ids are assigned here, not by the model: they are React keys and answer
    // handles, and a model that repeats one would break the picker silently.
    expect(new Set(questions[0]!.options.map((o) => o.id)).size).toBe(2);
  });

  it('finds the object inside prose or a code fence', () => {
    // Every model does this occasionally, whatever the prompt says. Throwing
    // the questions away over a "Here you go:" would send a user who could
    // have been asked straight into a guess.
    const questions = parseQuestions(
      'Sure! Here are my questions:\n```json\n' +
        JSON.stringify({
          questions: [
            { header: 'Data', question: 'Where should it live?', options: [{ label: 'A' }, { label: 'B' }] },
          ],
        }) +
        '\n```\nHope that helps.',
    );
    expect(questions).toHaveLength(1);
  });

  it('drops a question with fewer than two options', () => {
    // One option is not a question, it is an announcement, and rendering it
    // gives the user a button whose only effect is to agree.
    const questions = parseQuestions(
      JSON.stringify({
        questions: [
          { header: 'Stack', question: 'Which?', options: [{ label: 'Only one' }] },
          { header: 'Scope', question: 'How far?', options: [{ label: 'Small' }, { label: 'Full' }] },
        ],
      }),
    );
    expect(questions.map((q) => q.header)).toEqual(['Scope']);
  });

  it('never returns more than three', () => {
    const questions = parseQuestions(
      JSON.stringify({
        questions: Array.from({ length: 8 }, (_, i) => ({
          header: `H${i}`,
          question: `Q${i}?`,
          options: [{ label: 'a' }, { label: 'b' }],
        })),
      }),
    );
    expect(questions).toHaveLength(3);
  });

  it('returns nothing rather than throwing on junk', () => {
    // Every one of these ends with the build starting unasked, which is the
    // correct outcome: a clarifying step that can fail the prompt is worse
    // than no clarifying step.
    expect(parseQuestions('')).toEqual([]);
    expect(parseQuestions('I am not going to answer that.')).toEqual([]);
    expect(parseQuestions('{ this is not json }')).toEqual([]);
    expect(parseQuestions(JSON.stringify({ questions: 'no' }))).toEqual([]);
    expect(parseQuestions(JSON.stringify({ questions: [] }))).toEqual([]);
  });
});

describe('the questions we can ask without a model', () => {
  it('asks about the stack on a greenfield build that did not name one', () => {
    const questions = localQuestions('Build me a page where people can log in', undefined);
    expect(questions.some((q) => q.header === 'Tech stack')).toBe(true);
  });

  it('does not ask about the stack when the prompt already named it', () => {
    // "build it html css and js" is the end of that conversation. Asking
    // anyway is the app admitting it did not read the sentence.
    for (const goal of [
      'build a calendar tracker, html css and js',
      'Build me a login page with node',
      'a dashboard in React with Tailwind',
      'a MERN stack shop',
    ]) {
      expect(localQuestions(goal, undefined).some((q) => q.header === 'Tech stack')).toBe(false);
    }
  });

  it('asks how real sign-in should be when the prompt involves accounts', () => {
    // The other half of the login-page failure: "a login page" can mean the
    // screens or the whole authentication system, and building the wrong one
    // is a whole run wasted.
    const questions = localQuestions('Build me a login page with node', undefined);
    expect(questions.some((q) => q.header === 'Accounts')).toBe(true);
  });

  it('does not ask where the data lives when the prompt already said', () => {
    const questions = localQuestions('a task tracker backed by mongodb', undefined);
    expect(questions.some((q) => q.header === 'Data')).toBe(false);
  });

  it('does not ask about the stack when the project already has one', () => {
    // It is already decided, and asking makes the app look like it did not
    // look at the folder it is working in.
    const questions = localQuestions('Add a settings screen', 'The project already exists: 40 files');
    expect(questions.some((q) => q.header === 'Tech stack')).toBe(false);
  });

  it('asks where the data lives when the thing obviously holds data', () => {
    const questions = localQuestions('an activity tracker for my daily tasks', undefined);
    expect(questions.some((q) => q.header === 'Data')).toBe(true);
  });

  it('offers an auto option on every question', () => {
    // The whole design rests on this. If one question has no way to decline,
    // the step stops being optional and becomes a form.
    for (const brownfield of [undefined, 'The project already exists: 12 files']) {
      for (const q of localQuestions('build a task tracker with a calendar', brownfield)) {
        expect(q.options.some((o) => /^auto\b/i.test(o.label))).toBe(true);
      }
    }
  });

  it('never asks more than three things', () => {
    expect(localQuestions('build a calendar tracker that saves my tasks', undefined).length).toBeLessThanOrEqual(3);
  });
});

describe('folding the answers into the goal', () => {
  it('leaves the goal alone when nothing was answered', () => {
    expect(applyAnswers('Build a calculator', [])).toBe('Build a calculator');
  });

  it('ignores auto answers, which say nothing the planner did not already assume', () => {
    const goal = applyAnswers('Build a calculator', [
      { question: 'What stack?', answer: 'Auto — plain HTML/CSS/JS' },
      { question: 'How far?', answer: '   ' },
    ]);
    expect(goal).toBe('Build a calculator');
  });

  it('states real answers as settled decisions', () => {
    const goal = applyAnswers('Build a login page', [
      { question: 'What should this be built with?', answer: 'Node + Express' },
      { question: 'Where should the data live?', answer: 'A real database' },
    ]);

    expect(goal).toContain('Build a login page');
    expect(goal).toContain('What should this be built with? -> Node + Express');
    expect(goal).toContain('A real database');
    // Phrased as decided rather than as a conversation: a planner told about a
    // discussion is being invited to reopen it.
    expect(goal).toContain('These are settled');
  });

  it('keeps the real answers when some were auto', () => {
    const goal = applyAnswers('Build a tracker', [
      { question: 'What stack?', answer: 'Auto — you decide' },
      { question: 'Where does the data live?', answer: 'In the browser' },
    ]);
    expect(goal).toContain('In the browser');
    expect(goal).not.toContain('Auto —');
  });
});
