import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testIgnore: 'live.spec.ts',
  use: { baseURL: process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  reporter: 'list',
  webServer: process.env.PREVIEW_URL ? undefined : {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
