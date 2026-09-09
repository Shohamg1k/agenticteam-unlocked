import { expect, test } from '@playwright/test';

/**
 * Shell smoke tests.
 *
 * What these are for: proving the pieces are actually wired together — the
 * renderer builds, the WebSocket connects, the snapshot arrives, the panels
 * render from it, and the tab system works. A unit test cannot tell you that
 * the app boots.
 *
 * What they are NOT for: asserting on model behaviour. Nothing here spends a
 * token or requires a provider, so the suite runs in CI on a machine with no
 * keys and no CLI agents installed.
 */

test.describe('the shell', () => {
  test('boots, connects to the core service, and shows onboarding', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Agentic Team' })).toBeVisible();

    // The status bar reporting "Connected" is the real assertion here: it means
    // the WebSocket opened and a snapshot arrived.
    await expect(page.getByTitle('Core service: Connected')).toBeVisible();

    // Onboarding lists its three steps regardless of what is configured.
    // "Open a folder" also appears in the sidebar empty state, hence .first().
    await expect(page.getByText('Open a folder').first()).toBeVisible();
    await expect(page.getByText('Connect at least one model')).toBeVisible();
    await expect(page.getByText('Describe what you want built')).toBeVisible();
  });

  test('the activity rail switches sidebar panels', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Core service: Connected')).toBeVisible();

    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByPlaceholder('Search this project…')).toBeVisible();

    await page.getByRole('button', { name: 'Providers', exact: true }).click();
    // Every adapter is listed whether or not it is configured, so this holds
    // on a machine with nothing connected. Exact matching matters: the
    // "not configured" hint for this provider also contains its name.
    await expect(page.getByText('Anthropic API', { exact: true })).toBeVisible();
    await expect(page.getByText('Ollama (local)', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    await expect(page.getByText('Nothing waiting')).toBeVisible();
  });

  test('opens, focuses and closes tabs', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Core service: Connected')).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settingsTab = page.getByRole('tab', { name: /Settings/ });
    await expect(settingsTab).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();

    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByRole('tab', { name: /Chat/ })).toBeVisible();

    // Both tabs stay open; the second is focused.
    await expect(page.getByRole('tab')).toHaveCount(2);

    await page.getByRole('button', { name: 'Close Chat' }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);
  });

  test('opening a folder works from the button and from the File menu', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Core service: Connected')).toBeVisible();

    // The button. In a browser there is no native picker, so this is the
    // path-entry dialog — the same one the desktop app falls back to when the
    // picker fails.
    await page.getByRole('button', { name: 'Open a folder', exact: true }).last().click();
    await expect(page.getByRole('dialog', { name: 'Open a project folder' })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // The File menu. The Electron main process sends this over IPC and the
    // preload rebroadcasts it as exactly this DOM event. Nothing listened for
    // it once, so Ctrl+O silently did nothing.
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('agentic:menu', { detail: 'open-folder' })),
    );
    await expect(page.getByRole('dialog', { name: 'Open a project folder' })).toBeVisible();

    // Escape closes it, as it does in every dialog anyone has used.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('the open-folder dialog reports a bad path instead of failing silently', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Core service: Connected')).toBeVisible();

    await page.getByRole('button', { name: 'Open a folder', exact: true }).last().click();

    await page.getByLabel('Full path to the folder').fill('/definitely/not/a/real/folder');
    await page.getByRole('button', { name: 'Open', exact: true }).click();

    // The dialog stays open, says what was wrong, and keeps what was typed.
    await expect(page.getByText(/There is no folder at/)).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('Full path to the folder')).toHaveValue('/definitely/not/a/real/folder');
  });

  test('the routing policy editor renders the shipped policy', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Core service: Connected')).toBeVisible();

    await page.getByRole('button', { name: 'How routing works' }).click();
    // Without a project open, the editor explains why rather than erroring.
    await expect(page.getByText(/Open a project|Model routing/)).toBeVisible();
  });

  test('the cost dashboard renders with no spend', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Core service: Connected')).toBeVisible();

    await page.getByRole('button', { name: 'Cost dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Cost', exact: true })).toBeVisible();
    await expect(page.getByText('Saved by routing')).toBeVisible();
  });

  test('theme switching applies across the shell', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Core service: Connected')).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance' }).click();

    await page.getByLabel('Theme').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.getByLabel('Theme').selectOption('high-contrast');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');

    // Put it back, so a re-run starts from the same state.
    await page.getByLabel('Theme').selectOption('system');
  });

  test('reports every provider adapter with an actionable reason', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTitle('Core service: Connected')).toBeVisible();

    await page.getByRole('button', { name: 'Providers', exact: true }).click();

    // An unconfigured provider must say what to do about it, not just "off".
    // This is the assertion that would catch a regression to a bare status.
    await expect(page.getByText(/Add an Anthropic API key in Settings/)).toBeVisible();
    await expect(page.getByText(/free at console\.groq\.com/)).toBeVisible();
  });
});
