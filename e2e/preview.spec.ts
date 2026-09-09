import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Live Server path, end to end through the real UI.
 *
 * This is the case the preview used to have no answer for at all: a project of
 * plain HTML with no dev server. It said "No dev server command was detected"
 * for exactly the projects this app produces fastest, so the assertions here
 * are about the whole promise — the button offers to open the page, the server
 * starts, the page renders inside the app, and the overlay is running in it.
 *
 * Nothing here spends a token or needs a provider: the "project" is a file this
 * test writes. That is deliberate, so it runs in CI on a machine with no keys.
 */

const project = path.join(os.tmpdir(), `agentic-e2e-preview-${process.pid}`);

/** The core service, for setup and teardown that does not go through the UI. */
const API = 'http://127.0.0.1:4411/api';

/** Project ids opened by this spec, so they can be closed again. */
const opened = new Set<string>();

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Static fixture</title></head>
  <body>
    <h1 id="headline">Hello from a static project</h1>
    <button id="cta" type="button">Press me</button>
  </body>
</html>
`;

test.beforeAll(() => {
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'index.html'), PAGE);
  fs.writeFileSync(path.join(project, 'about.html'), PAGE.replace('Hello from', 'About'));
});

test.afterAll(async () => {
  // Leave the app as this spec found it. The suite runs sequentially against
  // one server, so a project left open changes what every later spec sees —
  // which is exactly what happened: the open-folder tests started failing on a
  // sidebar that already had a project in it, and only when run after this file.
  for (const id of opened) {
    await fetch(`${API}/projects/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  await fetch(`${API}/preview/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: [...opened][0] }),
  }).catch(() => undefined);

  fs.rmSync(project, { recursive: true, force: true });
});

/** Open the fixture as a project, through the API the renderer itself uses. */
async function openFixture(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTitle('Core service: Connected')).toBeVisible();

  const projectId = await page.evaluate(async (root) => {
    const res = await fetch('/api/projects/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    });
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new Error('the project did not open');
    await fetch(`/api/projects/${body.id}/activate`, { method: 'POST' });
    return body.id;
  }, project);

  expect(projectId).toBeTruthy();
  opened.add(projectId);

  // Every test in this file starts from "nothing is running". The suite shares
  // one server, so without this a test inherits whatever the previous one left
  // started — and the status-bar button, which says "Go Live" when stopped and
  // "Live" when running, then depends on test order rather than on behaviour.
  await fetch(`${API}/preview/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  }).catch(() => undefined);

  await page.reload();
  await expect(page.getByTitle('Core service: Connected')).toBeVisible();
}

test.describe('the preview', () => {
  test('offers to open an HTML project rather than demanding a dev server', async ({ page }) => {
    await openFixture(page);

    await page.getByRole('button', { name: 'Preview', exact: true }).click();

    // The wording is the feature. "Start the dev server" on a folder of HTML
    // files is a promise the app cannot keep and an instruction nobody can
    // follow.
    const start = page.getByRole('button', { name: /Open in browser|Start preview/ });
    await expect(start).toBeVisible();

    await start.click();

    // The served page appears inside the app, at the file's own path.
    const frame = page.frameLocator('iframe[title="Application preview"]');
    await expect(frame.locator('#headline')).toHaveText('Hello from a static project');

    // And the overlay is live in it — that is what makes the picker and the
    // annotations possible, and it silently stopped working once before when
    // the injected script was corrupted on its way into the page.
    const overlayInstalled = await page
      .frameLocator('iframe[title="Application preview"]')
      .locator('body')
      .evaluate(() => Boolean((window as unknown as { __agenticOverlayInstalled?: boolean }).__agenticOverlayInstalled));
    expect(overlayInstalled).toBe(true);
  });

  test('lets you switch between the pages of a static site', async ({ page }) => {
    await openFixture(page);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();

    const start = page.getByRole('button', { name: /Open in browser|Start preview/ });
    if (await start.isVisible()) await start.click();

    const picker = page.getByLabel('Page to preview');
    await expect(picker).toBeVisible();
    await picker.selectOption('about.html');

    await expect(
      page.frameLocator('iframe[title="Application preview"]').locator('#headline'),
    ).toHaveText('About a static project');
  });

  test('offers Go Live from the status bar, before the preview tab is even open', async ({ page }) => {
    await openFixture(page);

    // The gap this closes: the only way to see a finished build was to know a
    // Preview tab existed. The button says what it will do, so a folder of HTML
    // reads "Go Live" rather than the dev-server wording it cannot honour.
    const goLive = page.getByRole('button', { name: /Go Live/ });
    await expect(goLive).toBeVisible();

    await goLive.click();

    await expect(
      page.frameLocator('iframe[title="Application preview"]').locator('#headline'),
    ).toHaveText('Hello from a static project');
  });

  test('opens a page straight from the file tree', async ({ page }) => {
    await openFixture(page);

    // The Live Server gesture, in the place people already look for it.
    await page.getByRole('button', { name: 'Open about.html in the preview' }).click();

    await expect(
      page.frameLocator('iframe[title="Application preview"]').locator('#headline'),
    ).toHaveText('About a static project');
  });

  test('checks the rendered layout and reports what is broken', async ({ page }) => {
    await openFixture(page);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();

    const start = page.getByRole('button', { name: /Open in browser|Go Live|Start preview/ }).first();
    if (await start.isVisible()) await start.click();

    await page.getByRole('button', { name: 'Check layout' }).click();

    // The fixture is deliberately fine, so the check has to say so rather than
    // inventing something — a gate that always finds a problem is ignored.
    await expect(page.getByText(/Nothing visibly broken/)).toBeVisible({ timeout: 30_000 });
  });

  test('shows the annotate control once something is running', async ({ page }) => {
    await openFixture(page);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();

    const start = page.getByRole('button', { name: /Open in browser|Start preview/ });
    if (await start.isVisible()) await start.click();

    const annotate = page.getByRole('button', { name: /Annotate/ });
    await expect(annotate).toBeVisible();
    await expect(annotate).toHaveAttribute('aria-pressed', 'false');

    await annotate.click();
    await expect(page.getByRole('button', { name: /Drawing/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
