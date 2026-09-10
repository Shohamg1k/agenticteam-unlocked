import { previewState, startPreview } from './preview.js';
import { describeError, log } from './log.js';

/**
 * Bring the preview up while the build is still going.
 *
 * The complaint this exists for: "verification takes a lot of time and often
 * fails — make sure the preview spins up even while it is being built."
 *
 * That was an accurate description of the old shape. A task wrote its files
 * into memory, and they stayed there through a render pass and an install and
 * the project's whole test suite before anything touched the disk. For those
 * minutes the project folder was empty and the preview button had nothing to
 * serve, so the app looked stuck at "verifying" — and if a check then failed,
 * the user had watched a spinner for two minutes and received nothing at all.
 *
 * Now the orchestrator writes as soon as the cheap gates pass and calls this.
 * Everything here is best-effort by construction:
 *
 *  - It never throws into the run. A preview that cannot start is a preview
 *    that cannot start; it is not a build failure, and it must not become one.
 *  - It debounces, because a plan whose tasks land together would otherwise
 *    start, stop and restart a dev server three times in a second.
 *  - It does not restart a preview that is already running. A static server
 *    reloads on the file watcher and a dev server has its own reload; both
 *    handle new files better than a restart does.
 *  - It says the same thing once. Mid-build there is a stretch where the
 *    answer is legitimately "there is nothing to serve yet" — one line about
 *    that is information, and one per task is noise.
 */

const timers = new Map<string, NodeJS.Timeout>();
const lastSaid = new Map<string, string>();
const inFlight = new Set<string>();

/** How long to wait for more files before trying. */
const SETTLE_MS = 1_200;

export function nudgePreview(projectId: string, note?: (message: string) => void): void {
  const existing = timers.get(projectId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    timers.delete(projectId);
    void attempt(projectId, note);
  }, SETTLE_MS);

  // Never hold the process open for a preview nudge.
  timer.unref?.();
  timers.set(projectId, timer);
}

async function attempt(projectId: string, note?: (message: string) => void): Promise<void> {
  if (inFlight.has(projectId)) return;

  const current = previewState(projectId);
  // Running or on its way: the watcher and the dev server's own reload will
  // pick the new files up, and restarting would cost the user their tab.
  if (current?.status === 'running' || current?.status === 'starting') return;

  inFlight.add(projectId);
  try {
    const state = await startPreview(projectId);
    if (state.status === 'running' && state.url) {
      say(projectId, `Preview is up at ${state.url} — it is live while the rest of the checks run.`, note);
    } else if (state.error) {
      say(projectId, `Preview could not start yet: ${state.error}`, note);
    }
  } catch (err) {
    // The ordinary case, not an error: early in a build there is often no
    // HTML file and no dev server yet, because the task that writes them has
    // not finished. The next task nudges again.
    say(projectId, `No preview yet — ${describeError(err)}`, note);
  } finally {
    inFlight.delete(projectId);
  }
}

function say(projectId: string, message: string, note?: (message: string) => void): void {
  if (lastSaid.get(projectId) === message) return;
  lastSaid.set(projectId, message);
  note?.(message);
  log(message, 'info', { projectId });
}

/** Forget what we last said, so the next run reports its state afresh. */
export function resetPreviewNudge(projectId: string): void {
  const timer = timers.get(projectId);
  if (timer) clearTimeout(timer);
  timers.delete(projectId);
  lastSaid.delete(projectId);
}
