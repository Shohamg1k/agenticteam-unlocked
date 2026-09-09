import type { AgentProfile, SkillDef, Task } from './types.js';

/**
 * Choosing which skills and which specialist a task gets.
 *
 * This exists because a library only helps if it is filtered. The original
 * selection was "every skill whose capability tag matches", which is fine for
 * three built-in skills and ruinous for forty: a task would receive every piece
 * of guidance written for its capability, the context pack would fill with
 * advice about databases on a task about a stylesheet, and the fast profile's
 * whole budget would be gone before the brief was read.
 *
 * So relevance is scored, and the pack takes the best few. The scoring is
 * deliberately a keyword overlap rather than an embedding: it is inspectable,
 * it costs nothing, it has no model call in the hot path of every task, and
 * when it picks something odd a person can read the reason and fix the skill's
 * `whenToUse` line. A cleverer matcher that nobody can debug would be worse.
 */

/** Words too common to say anything about what a task is. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from',
  'this', 'that', 'these', 'those', 'it', 'its', 'is', 'are', 'was', 'be', 'been', 'as', 'if',
  'then', 'than', 'so', 'not', 'no', 'all', 'any', 'each', 'every', 'use', 'using', 'used',
  'make', 'makes', 'made', 'add', 'adds', 'new', 'set', 'get', 'you', 'your', 'we', 'our',
  'should', 'must', 'will', 'can', 'may', 'when', 'where', 'which', 'what', 'how', 'task',
  'file', 'files', 'code', 'project', 'create', 'build', 'write', 'implement', 'update',
]);

/**
 * Split text into comparable terms.
 *
 * Splits camelCase and identifiers too, because a task about `UserProfileCard`
 * should match a skill about "react component" — the words are in there, just
 * not separated by spaces.
 */
export function terms(text: string): string[] {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * How well `candidate` matches `query`, from 0 upward.
 *
 * Not normalised to 0-1 on purpose: the callers rank and threshold, and a
 * ratio would flatten the difference between one strong signal and four weak
 * ones, which is exactly the difference that matters here.
 */
export function overlapScore(queryTerms: string[], candidateText: string): number {
  if (!queryTerms.length) return 0;
  const candidate = new Set(terms(candidateText));
  if (!candidate.size) return 0;

  let score = 0;
  for (const term of queryTerms) {
    if (candidate.has(term)) {
      score += 1;
      continue;
    }
    // The same word in another form. Only an inflection counts: a bare prefix
    // match let "timer" match the "time" in "load time", and a pomodoro timer
    // was handed to the performance engineer on the strength of it. Being
    // nearly right about which specialist to use is worse than being unsure,
    // because the prompt then makes the model confident about the wrong domain.
    for (const c of candidate) {
      if (sameWord(term, c)) {
        score += 0.5;
        break;
      }
    }
  }
  return score;
}

/**
 * Are these two the same word in different forms?
 *
 * A deliberately small stemmer: only the suffixes that mean "same word,
 * different form". Anything cleverer would need a real stemming library in
 * shared code to buy back a handful of matches, and anything looser is what
 * produced "timer" matching "time".
 */
const INFLECTIONS = ['s', 'es', 'ed', 'd', 'ing', 'er', 'ers'];

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  // Below this, a suffix is most of the word and the match means nothing.
  if (shorter.length < 4) return false;
  if (!longer.startsWith(shorter)) return false;
  return INFLECTIONS.includes(longer.slice(shorter.length));
}

export interface SkillMatch {
  skill: SkillDef;
  score: number;
  /** Why it was picked, shown in the worklog so a surprising pick is debuggable. */
  reason: string;
}

/**
 * Rank skills for a task.
 *
 * Universal skills — no capability and no role declared — are always included
 * and always first. That is how a skill declares "this applies to everything":
 * the three built-in ones are about honesty, completeness and treating external
 * content as data, and a task that skips them is a task that ships a stub.
 */
export function rankSkills(
  skills: SkillDef[],
  task: Pick<Task, 'title' | 'description' | 'capability' | 'role'>,
  /**
   * Skills the chosen specialist declares. A profile that says it works with
   * `sql-and-schema-care` has already answered this question better than a
   * keyword match can, so its picks are ranked first among the non-universal
   * ones — otherwise `AgentProfile.skills` is a field nothing reads.
   */
  preferred: string[] = [],
): SkillMatch[] {
  // The title is the subject; the description is detail. Weighting them equally
  // let an incidental phrase decide — "a calculator with keyboard support" went
  // to the accessibility specialist on the word "keyboard", which is a fair
  // reading of the description and the wrong reading of the task.
  const titleTerms = terms(task.title);
  const bodyTerms = terms(task.description);
  const matches: SkillMatch[] = [];
  const wanted = new Set(preferred);

  for (const skill of skills) {
    if (!skill.enabled) continue;

    const universal = !skill.appliesTo.length && !skill.roles.length;
    if (universal) {
      matches.push({ skill, score: Number.POSITIVE_INFINITY, reason: 'applies to every task' });
      continue;
    }

    const roleMatch = Boolean(task.role && skill.roles.includes(task.role));
    const capabilityMatch = skill.appliesTo.includes(task.capability);
    if (!roleMatch && !capabilityMatch) continue;

    // The relevance text is what the skill says it is FOR, weighted above its
    // body: a skill's instructions mention many things it is not about.
    const about = `${skill.name} ${skill.whenToUse}`;
    const relevance =
      overlapScore(titleTerms, about) * 3 +
      overlapScore(bodyTerms, about) * 1 +
      overlapScore(titleTerms, skill.description) * 1.5 +
      overlapScore(bodyTerms, skill.body.slice(0, 600)) * 0.25;

    // A declared match with no keyword overlap still counts for something —
    // that is what the declaration is for — but ranks below a real one.
    const score =
      relevance + (wanted.has(skill.name) ? 4 : 0) + (roleMatch ? 2 : 0) + (capabilityMatch ? 1 : 0);

    matches.push({
      skill,
      score,
      reason: wanted.has(skill.name)
        ? 'the specialist on this task works with it'
        : roleMatch
          ? `written for the ${task.role} role`
          : relevance > 0
            ? 'matches what this task is about'
            : `written for ${task.capability} work`,
    });
  }

  return matches.sort((a, b) => b.score - a.score);
}

/**
 * The skills a task actually receives.
 *
 * Two limits, and both matter. `maxSkills` keeps the prompt readable — past a
 * handful, additional instructions dilute rather than sharpen. `maxChars`
 * keeps a single verbose skill from consuming a lean profile's whole budget.
 */
export function selectSkills(
  skills: SkillDef[],
  task: Pick<Task, 'title' | 'description' | 'capability' | 'role'>,
  opts: { maxSkills?: number; maxChars?: number; preferred?: string[] } = {},
): SkillDef[] {
  const maxSkills = opts.maxSkills ?? 6;
  const maxChars = opts.maxChars ?? 8_000;

  const chosen: SkillDef[] = [];
  let used = 0;
  let discretionary = 0;

  for (const match of rankSkills(skills, task, opts.preferred)) {
    // A universal skill is always included, and does NOT count against the
    // limit. It cannot: there are three of them, so a limit of three would mean
    // a task on the fast profile received the honesty rules and no guidance
    // about the work — which is the opposite of the intent. `maxSkills` counts
    // the ones that were chosen for THIS task.
    const universal = match.score === Number.POSITIVE_INFINITY;

    if (universal) {
      chosen.push(match.skill);
      used += match.skill.body.length;
      continue;
    }

    if (discretionary >= maxSkills) break;
    if (used + match.skill.body.length > maxChars) continue;

    chosen.push(match.skill);
    used += match.skill.body.length;
    discretionary++;
  }

  return chosen;
}

export interface AgentMatch {
  agent: AgentProfile;
  score: number;
  reason: string;
}

/**
 * Pick the specialist for a task.
 *
 * The point of a library of specialists is that a task about a database
 * migration gets someone who knows what a migration is, rather than the same
 * generic engineer every time. But a wrong specialist is worse than a generic
 * one — it tells the model to be confident about the wrong thing — so a profile
 * has to earn the job with real overlap, not just a shared capability tag.
 *
 * Returns undefined when nothing is a clear match, and the caller then uses the
 * role prompt or the generic worker. That is the correct outcome for most
 * tasks, and a matcher that always finds something would be useless.
 */
export function selectAgent(
  agents: AgentProfile[],
  task: Pick<Task, 'title' | 'description' | 'capability' | 'role'>,
  opts: { minScore?: number } = {},
): AgentMatch | undefined {
  const minScore = opts.minScore ?? 3;
  // Same weighting as skills, for the same reason: the title says what the task
  // is, the description says what else is true about it.
  const titleTerms = terms(task.title);
  const bodyTerms = terms(task.description);

  const enabled = agents.filter((agent) => agent.enabled);

  /**
   * When the planner named a role, choose among the people who do that job.
   *
   * The planner's assignment is a decision; keyword overlap is a heuristic, and
   * letting the heuristic outvote the decision produces exactly the confusion
   * it did: a "Build the settings screen" task assigned to the frontend
   * engineer went to the accessibility specialist, because "screen" the noun
   * collides with "screen reader". No amount of tuning fixes that class of
   * collision; scoping the candidates does.
   */
  const sameRole = task.role ? enabled.filter((a) => a.role === task.role) : [];
  const candidates = sameRole.length ? sameRole : enabled;

  const ranked = candidates
    .map((agent): AgentMatch => {
      const about = `${agent.name} ${agent.whenToUse}`;
      const relevance =
        overlapScore(titleTerms, about) * 3 +
        overlapScore(bodyTerms, about) * 1 +
        overlapScore(titleTerms, agent.description) * 1.5;

      const capabilityMatch = agent.capability === task.capability;
      const roleMatch = Boolean(task.role && agent.role === task.role);

      // Capability and role are gates on plausibility, not evidence of fit.
      // Without real overlap on top, a profile is not the right specialist —
      // it is just one of the many that could technically do the work.
      const score = relevance + (capabilityMatch ? 1 : 0) + (roleMatch ? 1.5 : 0);

      return {
        agent,
        score,
        reason: relevance
          ? `${agent.description.toLowerCase()} — matches this task`
          : roleMatch
            ? `the ${task.role} on this team`
            : 'general fit',
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < minScore) return undefined;

  // A tie means neither is the specialist. Picking one anyway would be a coin
  // flip dressed up as a decision, and the generic prompt is the honest answer.
  //
  // The one exception is a profile that IS this task's assigned role — that is
  // not a tie broken arbitrarily, it is the person the planner named. Note the
  // explicit `task.role` check: without it, two role-less profiles tie with
  // `undefined !== undefined` being false, and the guard silently never fires.
  const runnerUp = ranked[1];
  const isAssignedRole = Boolean(task.role) && best.agent.role === task.role;
  if (runnerUp && best.score - runnerUp.score < 0.5 && !isAssignedRole) return undefined;

  return best;
}
