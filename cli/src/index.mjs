#!/usr/bin/env node
/**
 * `at` — a headless client for the Agentic Team core service.
 *
 * It is a first-class client, not a side door: it uses the same HTTP routes the
 * desktop app does, so it inherits the same human gate. `at accept` cannot
 * apply a tainted task any more than the UI can, because the check is on the
 * server (ADR 0004).
 *
 * Plain `.mjs` with no dependencies and no build step — a CLI that needs
 * compiling before it can tell you why the app will not start is a CLI that
 * fails when you need it most.
 */

import process from 'node:process';

const PORT = process.env.AGENTIC_PORT ?? '4400';
const BASE = `http://127.0.0.1:${PORT}/api`;

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (colour ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (colour ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (colour ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (colour ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (colour ? `\x1b[31m${s}\x1b[0m` : s),
  blue: (s) => (colour ? `\x1b[34m${s}\x1b[0m` : s),
};

async function request(path, init = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch {
    fail(
      'Cannot reach the Agentic Team core service.',
      `Start the app, or run the service directly with: npm run dev:server\n(Looking on port ${PORT}; set AGENTIC_PORT to change it.)`,
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(body.error ?? `Request failed (${response.status})`, body.hint);
  return body;
}

function fail(message, hint) {
  console.error(c.red(`error: ${message}`));
  if (hint) console.error(c.dim(hint));
  process.exit(1);
}

const STATUS_COLOUR = {
  done: c.green,
  failed: c.red,
  review: c.yellow,
  running: c.blue,
  verifying: c.blue,
};

function statusOf(status) {
  return (STATUS_COLOUR[status] ?? c.dim)(status);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands = {
  async status() {
    const snapshot = await request('/snapshot');
    const project = snapshot.projects.find((p) => p.id === snapshot.activeProjectId);

    console.log(c.bold('Agentic Team'));
    console.log(`  project    ${project ? `${project.name} ${c.dim(project.root)}` : c.dim('none open')}`);
    console.log(`  gate       ${snapshot.config.executionMode}`);

    const ready = snapshot.providers.filter((p) => p.available);
    console.log(`  providers  ${ready.length} ready of ${snapshot.providers.length}`);
    for (const provider of snapshot.providers) {
      const mark = provider.available ? c.green('ok  ') : c.dim('off ');
      console.log(`    ${mark} ${provider.name.padEnd(18)} ${c.dim(provider.detail ?? '')}`);
    }

    const running = snapshot.tasks.filter((t) => t.status === 'running' || t.status === 'verifying');
    const waiting = snapshot.reviewQueue.filter((i) => i.status === 'open');
    console.log(`  running    ${running.length} task(s)`);
    console.log(`  inbox      ${waiting.length} awaiting you`);
    console.log(`  spent      $${snapshot.usage.totalCostUsd.toFixed(4)} today`);
  },

  async open(root) {
    if (!root) fail('Usage: at open <folder>');
    const project = await request('/projects/open', {
      method: 'POST',
      body: JSON.stringify({ root }),
    });
    console.log(`${c.green('opened')} ${project.name} ${c.dim(project.root)}`);
  },

  async plan(...words) {
    const professional = words.includes('--pro');
    const goal = words.filter((w) => w !== '--pro').join(' ');
    if (!goal) fail('Usage: at plan [--pro] <what you want built>');

    const snapshot = await request('/snapshot');
    if (!snapshot.activeProjectId) fail('No project is open.', 'Run: at open <folder>');

    console.log(c.dim('planning...'));
    const result = await request('/plans', {
      method: 'POST',
      body: JSON.stringify({
        projectId: snapshot.activeProjectId,
        goal,
        mode: professional ? 'professional' : 'instant',
        autoStart: true,
      }),
    });

    console.log(`${c.green('planned')} by ${result.plannedBy} — ${result.tasks.length} task(s)`);
    if (result.plan.summary) console.log(c.dim(result.plan.summary));
    for (const task of result.tasks) {
      const deps = task.dependsOn.length ? c.dim(` after ${task.dependsOn.length} task(s)`) : '';
      console.log(`  ${c.dim('-')} ${task.title}${deps}`);
      console.log(`    ${c.dim(`${task.capability} · complexity ${task.complexity} · ${task.plannedProviderId ?? 'router picks'}`)}`);
    }
    console.log(c.dim('\nWatch it with: at watch'));
  },

  async tasks() {
    const snapshot = await request('/snapshot');
    if (!snapshot.tasks.length) return console.log(c.dim('no tasks'));

    for (const plan of snapshot.plans) {
      const tasks = snapshot.tasks.filter((t) => t.planId === plan.id);
      const done = tasks.filter((t) => t.status === 'done').length;
      console.log(`${c.bold(plan.goal.slice(0, 70))} ${c.dim(`[${plan.status}] ${done}/${tasks.length}`)}`);
      for (const task of tasks) {
        console.log(
          `  ${statusOf(task.status).padEnd(colour ? 20 : 10)} ${task.title.slice(0, 50).padEnd(52)} ${c.dim(task.providerId ?? '')}`,
        );
      }
    }
  },

  /** Follow progress until everything settles. */
  async watch() {
    let lastLine = '';
    for (;;) {
      const snapshot = await request('/snapshot');
      const tasks = snapshot.tasks;
      const running = tasks.filter((t) => t.status === 'running' || t.status === 'verifying');
      const done = tasks.filter((t) => t.status === 'done').length;
      const review = tasks.filter((t) => t.status === 'review').length;

      const line = running.length
        ? `${done}/${tasks.length} done · ${running.map((t) => `${t.title.slice(0, 30)} (${t.providerId ?? '...'})`).join(', ')}`
        : `${done}/${tasks.length} done · ${review} awaiting you`;

      if (line !== lastLine) {
        console.log(`${c.dim(new Date().toLocaleTimeString())} ${line}`);
        lastLine = line;
      }

      const settled = !running.length && !snapshot.plans.some((p) => p.status === 'running');
      if (settled) {
        if (review) console.log(c.yellow(`\n${review} task(s) need your decision. Run: at inbox`));
        else console.log(c.green('\nnothing left running'));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  },

  async inbox() {
    const snapshot = await request('/snapshot');
    const open = snapshot.reviewQueue.filter((i) => i.status === 'open');
    if (!open.length) return console.log(c.dim('inbox is empty'));

    for (const item of open) {
      console.log(`${c.yellow(`[${item.kind}]`)} ${c.bold(item.title)}`);
      console.log(
        item.detail
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
      );
      if (item.taskId) console.log(c.dim(`  accept with: at accept ${item.taskId}`));
      console.log();
    }
  },

  async diff(taskId) {
    if (!taskId) fail('Usage: at diff <taskId>');
    const result = await request(`/tasks/${taskId}/diff`);
    if (!result.files.length) return console.log(c.dim('no pending files'));

    for (const file of result.files) {
      console.log(c.bold(`--- ${file.path} [${file.status}]`));
      for (const hunk of file.hunks) {
        console.log(c.dim(hunk.header));
        for (const line of hunk.lines) {
          const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
          const paint = line.kind === 'add' ? c.green : line.kind === 'remove' ? c.red : c.dim;
          console.log(paint(`${prefix}${line.text}`));
        }
      }
    }
  },

  async accept(taskId) {
    if (!taskId) fail('Usage: at accept <taskId>');
    const result = await request(`/tasks/${taskId}/apply`, { method: 'POST', body: '{}' });
    console.log(`${c.green('applied')} ${result.applied.length} file(s):`);
    for (const file of result.applied) console.log(`  ${file}`);
  },

  async reject(taskId, ...reason) {
    if (!taskId) fail('Usage: at reject <taskId> [reason]');
    await request(`/tasks/${taskId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.join(' ') || 'Rejected from the CLI' }),
    });
    console.log(`${c.green('rejected')} — nothing was written to your project`);
  },

  async providers() {
    const providers = await request('/providers');
    for (const provider of providers) {
      const mark = provider.available ? c.green('ok ') : c.dim('off');
      const quota = provider.quota.limitRpd
        ? c.dim(` ${provider.quota.usedDay}/${provider.quota.limitRpd} today`)
        : provider.quota.costTodayUsd
          ? c.dim(` $${provider.quota.costTodayUsd.toFixed(4)} today`)
          : '';
      console.log(`${mark} ${c.bold(provider.name.padEnd(20))} ${c.dim(`tier ${provider.tier} ${provider.kind}`)}${quota}`);
      if (provider.detail) console.log(`    ${c.dim(provider.detail)}`);
    }
  },

  async cost() {
    const snapshot = await request('/snapshot');
    const { usage } = snapshot;
    console.log(c.bold(`$${usage.totalCostUsd.toFixed(4)} spent`));
    const saved = Math.max(0, usage.baselineCostUsd - usage.totalCostUsd);
    if (saved > 0) console.log(c.green(`$${saved.toFixed(2)} saved by routing (estimate)`));
    for (const provider of usage.byProvider.filter((p) => p.calls)) {
      console.log(
        `  ${provider.name.padEnd(20)} ${String(provider.calls).padStart(5)} calls  ${
          provider.costUsd === 0 ? c.green('free') : `$${provider.costUsd.toFixed(4)}`
        }`,
      );
    }
  },

  /**
   * A bounded view of the state for another agent to act on — far smaller than
   * the raw snapshot, which is mostly detail no decision depends on.
   */
  async snapshot() {
    const snapshot = await request('/snapshot');
    const project = snapshot.projects.find((p) => p.id === snapshot.activeProjectId);
    console.log(
      JSON.stringify(
        {
          project: project ? { name: project.name, root: project.root } : null,
          executionMode: snapshot.config.executionMode,
          providers: snapshot.providers.filter((p) => p.available).map((p) => ({ id: p.id, kind: p.kind, tier: p.tier })),
          plans: snapshot.plans.map((p) => ({ id: p.id, goal: p.goal, status: p.status, mode: p.mode })),
          tasks: snapshot.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            provider: t.providerId,
            files: t.producedFiles,
          })),
          awaitingYou: snapshot.reviewQueue
            .filter((i) => i.status === 'open')
            .map((i) => ({ id: i.id, kind: i.kind, title: i.title, taskId: i.taskId })),
          spentUsd: Number(snapshot.usage.totalCostUsd.toFixed(4)),
        },
        null,
        2,
      ),
    );
  },

  help() {
    console.log(`${c.bold('at')} — Agentic Team from the command line

  ${c.bold('at status')}                  what is connected, running and waiting
  ${c.bold('at open')} <folder>           open a folder as the active project
  ${c.bold('at plan')} [--pro] <goal>     plan and start work (--pro for the full SDLC team)
  ${c.bold('at watch')}                   follow progress until it settles
  ${c.bold('at tasks')}                   the current task board
  ${c.bold('at inbox')}                   decisions waiting for you
  ${c.bold('at diff')} <taskId>           what a task wants to change
  ${c.bold('at accept')} <taskId>         apply it to your project
  ${c.bold('at reject')} <taskId> [why]   discard it — nothing was written anyway
  ${c.bold('at providers')}               the failover ladder and quota
  ${c.bold('at cost')}                    spend, and what routing saved
  ${c.bold('at snapshot')}                bounded JSON state, for another agent

${c.dim(`Talks to the core service on port ${PORT} (set AGENTIC_PORT to change it).`)}
${c.dim('The human gate is enforced on the server, so the CLI has exactly the same limits as the app.')}`);
  },
};

const [command, ...args] = process.argv.slice(2);
const handler = commands[command ?? 'help'];

if (!handler) {
  console.error(c.red(`Unknown command: ${command}`));
  commands.help();
  process.exit(1);
}

handler(...args).catch((err) => fail(err instanceof Error ? err.message : String(err)));
