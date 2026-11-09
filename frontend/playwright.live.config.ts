import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'live.spec.ts',
  outputDir: '../test-results/live-browser-artifacts',
  workers: 1,
  timeout: 240000,
  expect: { timeout: 20000 },
  use: {
    baseURL: process.env.LIVE_URL ?? 'http://127.0.0.1:8000',
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  reporter: [['list'], ['json', { outputFile: '../test-results/live-browser-results.json' }]],
});
