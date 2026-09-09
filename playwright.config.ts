import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * End-to-end smoke tests for the shell.
 *
 * They run against the real core service and the real renderer, with an
 * isolated data directory so a developer's own projects and keys are never
 * touched by a test run. That isolation is the reason `AGENTIC_DATA_DIR`
 * exists as an override at all.
 *
 * Deliberately smoke-level: these prove the app boots, connects, renders and
 * responds. Behaviour that can be tested without a browser is tested in Vitest,
 * where it runs in milliseconds instead of seconds.
 */

const E2E_PORT = 4411;
const E2E_WEB_PORT = 5274;
const dataDir = path.join(process.cwd(), '.e2e-data');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: `http://localhost:${E2E_WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'npx tsx server/src/index.ts',
      port: E2E_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        AGENTIC_PORT: String(E2E_PORT),
        AGENTIC_DATA_DIR: dataDir,
      },
    },
    {
      command: `npx vite --port ${E2E_WEB_PORT} --strictPort`,
      cwd: path.join(process.cwd(), 'web'),
      port: E2E_WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { AGENTIC_PORT: String(E2E_PORT) },
    },
  ],
});
