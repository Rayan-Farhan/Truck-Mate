import { expect, test } from '@playwright/test';

test('account pages share the planner palette and expose email recovery', async ({ page }) => {
  await page.route('**/api/fleet/session', (route) =>
    route.fulfill({ json: { user: null, email_enabled: true } }),
  );
  await page.route('**/api/fleet/password/request', (route) => route.fulfill({ json: { ok: true } }));
  await page.goto('/fleet');
  await expect(page.locator('.fleet-shell')).toHaveCSS('background-color', 'rgb(20, 20, 20)');
  await expect(page.getByRole('heading', { name: 'Fleet sign-in' })).toBeVisible();
  await page.getByRole('link', { name: 'Register a fleet' }).click();
  await expect(page.getByLabel('Company name')).toBeVisible();
  await page.getByRole('link', { name: 'Back to sign-in' }).click();
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page).toHaveURL(/\/fleet\/recover$/);
  await page.getByLabel('Email').fill('driver@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('send a password reset link');
});
