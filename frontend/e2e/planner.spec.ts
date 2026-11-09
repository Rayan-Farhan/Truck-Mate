import { test, expect } from '@playwright/test';

// Controlled form regressions; live provider acceptance is in live.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/config', (route) => route.fulfill({
    json: { live_routing: true, bedrock: false, groq: false },
  }));
});

test('opens a live planner without demo controls or automatic analysis', async ({ page }) => {
  let analyses = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/analyses')) analyses++;
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Find routes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Demo', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Scenario')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'FROM', exact: true })).toBeEditable();
  expect(analyses).toBe(0);
});

test('methodology closes with Escape and preserves inputs', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('PAYLOAD WEIGHT', { exact: true }).fill('70990');
  await page.getByRole('button', { name: 'How it works' }).click();
  await expect(page.getByRole('dialog')).toContainText('The assessment thresholds');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('PAYLOAD WEIGHT', { exact: true })).toHaveValue('70990');
});

test('empty suggestions and unselected text cannot submit an invalid trip', async ({ page }) => {
  await page.route('**/api/places?*', (route) => route.fulfill({ json: { results: [] } }));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let requests = 0;
  await page.route('**/api/analyses', (route) => {
    requests++;
    return route.abort();
  });
  await page.goto('/');
  const origin = page.getByRole('combobox', { name: 'FROM', exact: true });
  await origin.fill('Seattle');
  await expect(page.getByText('No matching places. Try a city and state.')).toBeVisible();
  await origin.press('ArrowUp');
  await origin.press('Enter');
  await expect(origin).toHaveValue('Seattle');
  await page.getByRole('button', { name: 'Find routes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Choose both locations');
  expect(requests).toBe(0);
  expect(errors).toEqual([]);
});

test('payload validation and swap preserve live request values', async ({ page }) => {
  const sent: any[] = [];
  await page.route('**/api/analyses', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      status: 503,
      json: { error: { code: 'TEST_ERROR', message: 'Controlled provider error' } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Swap origin and destination' }).click();
  await expect(page.getByRole('combobox', { name: 'FROM', exact: true })).toHaveValue('Denver, CO');
  const input = page.getByLabel('PAYLOAD WEIGHT', { exact: true });
  for (const value of ['', '-1', '80001']) {
    await input.fill(value);
    await page.getByRole('button', { name: 'Find routes', exact: true }).click();
    expect(await input.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  }
  expect(sent).toHaveLength(0);
  for (const value of ['0', '80000']) {
    await input.fill(value);
    const response = page.waitForResponse((r) => r.url().endsWith('/api/analyses'));
    await page.getByRole('button', { name: 'Find routes', exact: true }).click();
    await response;
    await expect(page.getByRole('alert')).toContainText('Controlled provider error');
    expect(sent.at(-1).load_weight_lb).toBe(Number(value));
    expect(sent.at(-1).mode).toBe('live');
    expect(sent.at(-1).scenario).toBeUndefined();
    expect(sent.at(-1).origin.lat).toBe(39.7392);
    expect(sent.at(-1).destination.lat).toBe(41.8781);
  }
});

test('location provider failure has a working retry button', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/places?*', (route) =>
    new URL(route.request().url()).searchParams.get('q') !== 'Seattle'
      ? route.fulfill({ json: { results: [] } })
      : ++attempts === 1
        ? route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'PROVIDER_CONNECTION',
                message: 'TomTom location search is temporarily unavailable.',
              },
            },
          })
        : route.fulfill({ json: { results: [{ label: 'Seattle, WA', lat: 47.6, lon: -122.3 }] } }),
  );
  await page.goto('/');
  await page.getByRole('combobox', { name: 'FROM', exact: true }).fill('Seattle');
  await expect(page.getByRole('alert')).toContainText('TomTom location search');
  await page.getByRole('button', { name: 'Retry location search', exact: true }).click();
  await page.getByRole('option', { name: 'Seattle, WA', exact: true }).click();
  expect(attempts).toBe(2);
});
