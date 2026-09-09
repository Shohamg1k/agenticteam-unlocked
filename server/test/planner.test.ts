import { describe, expect, it } from 'vitest';
import { PlannerError, parsePlannerResponse } from '../src/planner.js';

/**
 * The planner's output is untrusted input.
 *
 * A model returns JSON wrapped in prose, JSON in a fence, JSON with a trailing
 * apology, or no JSON at all — and a plan that silently comes back empty looks
 * to a user exactly like a hang. These tests pin the extraction behaviour and
 * the failure message.
 */
describe('parsePlannerResponse', () => {
  const graph = { summary: 'a plan', tasks: [{ id: 't1', title: 'Do it' }] };

  it('parses a bare JSON object', () => {
    expect(parsePlannerResponse(JSON.stringify(graph)).tasks).toHaveLength(1);
  });

  it('parses JSON inside a fenced block', () => {
    const text = `Here is the plan:\n\n\`\`\`json\n${JSON.stringify(graph, null, 2)}\n\`\`\`\n\nLet me know.`;
    expect(parsePlannerResponse(text).summary).toBe('a plan');
  });

  it('parses JSON inside an unlabelled fence', () => {
    expect(parsePlannerResponse(`\`\`\`\n${JSON.stringify(graph)}\n\`\`\``).tasks).toHaveLength(1);
  });

  it('parses JSON surrounded by prose with no fence', () => {
    const text = `I'll break this into one task. ${JSON.stringify(graph)} That should cover it.`;
    expect(parsePlannerResponse(text).tasks).toHaveLength(1);
  });

  it('handles braces inside string values without truncating', () => {
    const tricky = {
      summary: 'uses { and } in a contract',
      tasks: [{ id: 't1', title: 'x', contract: 'type T = { a: string }' }],
    };
    const parsed = parsePlannerResponse(`prose ${JSON.stringify(tricky)} more prose`);
    expect(parsed.tasks?.[0]?.contract).toBe('type T = { a: string }');
  });

  it('handles escaped quotes inside string values', () => {
    const tricky = { tasks: [{ id: 't1', title: 'say \\"hello\\" loudly' }] };
    const raw = JSON.stringify(tricky);
    expect(parsePlannerResponse(`x ${raw} y`).tasks).toHaveLength(1);
  });

  it('throws a PlannerError, with the raw text, when there is no JSON', () => {
    expect(() => parsePlannerResponse('I would start by refactoring the login flow.')).toThrow(PlannerError);
    try {
      parsePlannerResponse('I would start by refactoring the login flow.');
    } catch (err) {
      // The hint must carry enough to diagnose it — a bare "parse failed" is
      // useless when the model is the thing that misbehaved.
      expect((err as PlannerError).hint).toContain('refactoring');
    }
  });

  it('rejects valid JSON that is not a task graph', () => {
    expect(() => parsePlannerResponse('{"summary":"no tasks here"}')).toThrow(PlannerError);
  });

  it('accepts an empty task array at parse time (materialise rejects it later)', () => {
    expect(parsePlannerResponse('{"tasks":[]}').tasks).toEqual([]);
  });
});
