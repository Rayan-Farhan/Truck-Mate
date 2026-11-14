import { expect, test } from '@playwright/test';

test('account pages share the planner palette and expose email recovery', async ({ page }) => {
  await page.route('**/api/fleet/session', (route) =>
    route.fulfill({ json: { user: null, email_enabled: true } }),
  );
  await page.route('**/api/fleet/password/request', (route) => route.fulfill({ json: { ok: true } }));
  await page.goto('/fleet');
  await expect(page.locator('.fleet-shell')).toHaveCSS('background-color', 'rgb(20, 20, 20)');
  await expect(page.getByRole('heading', { name: 'Driver sign-in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Register a fleet' })).toHaveCount(0);
  const portalLinks = page.getByRole('link', { name: /^(admin sign-in|driver sign-in|driver portal)$/i });
  await expect(portalLinks).toHaveCount(0);
  await page.goto('/fleet/admin');
  await expect(page.getByRole('heading', { name: 'Admin sign-in' })).toBeVisible();
  await expect(portalLinks).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute('href', '/fleet/admin/recover');
  await page.goto('/fleet');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page).toHaveURL(/\/fleet\/recover$/);
  await page.getByLabel('Email').fill('driver@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('send a password reset link');
});

test('admin management views are separated by tab', async ({ page }) => {
  await page.route('**/api/fleet/**', (route) => {
    const user = { id: 1, username: 'admin@example.com', role: 'admin', company: 'TruckMate' };
    return route.fulfill({
      json: route.request().url().endsWith('/session') ? { user, email_enabled: false } : [],
    });
  });
  await page.goto('/fleet/admin');
  const tabs = page.getByRole('navigation', { name: 'Admin portal' });
  await expect(page.getByRole('heading', { name: 'Job board' })).toBeVisible();
  await tabs.getByRole('link', { name: 'Assign a Job' }).click();
  await expect(page.getByRole('heading', { name: 'Pickup and delivery map' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Pickup' })).toBeVisible();
  await tabs.getByRole('link', { name: 'Trucks' }).click();
  await expect(page.getByRole('button', { name: 'Add truck' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite driver' })).toHaveCount(0);
  await tabs.getByRole('link', { name: 'Drivers' }).click();
  await expect(page.getByRole('button', { name: 'Invite driver' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite admin' })).toBeVisible();
});
