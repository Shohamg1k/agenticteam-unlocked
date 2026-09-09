import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'server/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    coverage: { provider: 'v8', reporter: ['text', 'html'], include: ['packages/*/src/**', 'server/src/**'] },
  },
});
