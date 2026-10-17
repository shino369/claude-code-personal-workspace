import { defineConfig } from '@playwright/test';

// Playwright is reserved for e2e tests. Keep testDir isolated from the Vitest
// suite so `playwright test` never picks up unit tests.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.{js,ts}',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
  },
});
