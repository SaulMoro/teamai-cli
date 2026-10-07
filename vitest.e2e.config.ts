import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/e2e/**/*.test.ts',
      'src/__tests__/*-e2e.test.ts',
      'validation/*.test.ts',
    ],
    setupFiles: ['src/__tests__/helpers/clear-agent-session-env.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Build before the runner: rebuilding inside a test would delete dist
    // while another file's CLI subprocess is using it.
    fileParallelism: true,
    minWorkers: 1,
    maxWorkers: process.env.CI ? 2 : 4,
    // Retry once: flaky tests recover, real bugs stay failed.
    retry: 1,
  },
});
