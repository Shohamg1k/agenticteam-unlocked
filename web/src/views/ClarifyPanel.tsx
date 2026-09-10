import React, { useState } from 'react';
import type { ClarifyingAnswer, ClarifyingQuestion } from '@agentic/core';

/**
 * The questions between the prompt and the build.
 *
 * The rule this is designed around: **nobody is made to answer**. A prompt is
 * already a complete instruction, and a person who typed one and meant it
 * should be able to get past this in a single click — so the primary action is
 * always "Build it", enabled from the first frame, and the questions are there
 * to be used rather than to be satisfied. Anything unanswered is taken as auto,
 * which is genuinely what the planner would have done unasked.
 *
 * What the questions buy, when someone does answer, is the difference between
 * the build the prompt described and the build they meant. "A login page with
 * node" produced a static HTML file once; three seconds on a stack question is
 * cheaper than finding that out at the end.
 */

export function ClarifyPanel({
  questions,
  onBuild,
  onCancel,
  busy,
}: {
  questions: ClarifyingQuestion[];
  onBuild: (answers: ClarifyingAnswer[]) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});

  const answers = (): ClarifyingAnswer[] =>
    questions
      .filter((q) => picked[q.id])
      .map((q) => ({ question: q.question, answer: picked[q.id]! }));

  const answered = Object.keys(picked).length;

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card__header">
        <h2 className="card__title">A couple of things before I start</h2>
        <span className="badge badge--neutral">optional</span>
      </div>

      <div className="card__body col" style={{ gap: 18 }}>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
          Answer what you have an opinion about and skip the rest — anything you leave alone is decided the
          way it would have been anyway.
        </p>

        {questions.map((q) => (
          <div key={q.id} className="col" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <span className="badge badge--neutral">{q.header}</span>
              <strong style={{ fontSize: 'var(--text-sm)' }}>{q.question}</strong>
            </div>

            <div className="col" style={{ gap: 6 }}>
              {q.options.map((opt) => {
                const selected = picked[q.id] === opt.label;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`btn ${selected ? 'btn--primary' : ''}`}
                    aria-pressed={selected}
                    disabled={busy}
                    style={{
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      height: 'auto',
                      padding: '8px 10px',
                      lineHeight: 1.4,
                    }}
                    onClick={() =>
                      // Clicking the chosen option again clears it. Without
                      // that there is no way back to "no opinion" short of
                      // starting the prompt over, and a radio group you cannot
                      // leave is a trap rather than a choice.
                      setPicked((prev) => {
                        const next = { ...prev };
                        if (next[q.id] === opt.label) delete next[q.id];
                        else next[q.id] = opt.label;
                        return next;
                      })
                    }
                  >
                    <span className="col" style={{ gap: 2, alignItems: 'flex-start' }}>
                      <span>{opt.label}</span>
                      {opt.detail && (
                        <span
                          className={selected ? '' : 'subtle'}
                          style={{ fontSize: 'var(--text-xs)', fontWeight: 400 }}
                        >
                          {opt.detail}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="card__footer" style={{ justifyContent: 'space-between', gap: 8 }}>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onCancel}>
          Back to the prompt
        </button>
        <span className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
            {answered === 0
              ? 'Nothing answered — I will decide'
              : `${answered} of ${questions.length} answered`}
          </span>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onBuild(answers())}>
            {busy ? <span className="spinner" /> : null}
            {busy ? 'Planning…' : 'Build it'}
          </button>
        </span>
      </div>
    </section>
  );
}
