import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testIgnore: 'live.spec.ts',
  use: { baseURL: process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  reporter: 'list',
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
