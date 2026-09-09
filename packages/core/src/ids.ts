import { randomUUID } from 'node:crypto';

/**
 * Short, sortable, human-quotable ids. Prefixed by kind so a stray id in a log
 * line tells you what it points at without a lookup.
 */
export function rid(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export const newTaskId = () => rid('t');
export const newPlanId = () => rid('p');
export const newRunId = () => rid('r');
export const newCheckpointId = () => rid('cp');
export const newMessageId = () => rid('m');
