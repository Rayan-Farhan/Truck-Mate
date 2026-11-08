import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// These tests never intercept API responses or substitute weather/routing data.
// Run explicitly: npm run test:live. Providers and credentials must be configured.
const levels = ['low', 'moderate', 'high', 'severe', 'no_travel'];
function band(value: number | null, limits: number[], strict = false) {
  if (value === null) return null;
  let result = 0;
  limits.forEach((limit, i) => {
    if (strict && i === 3 ? value > limit : value >= limit) result = i + 1;
  });
  return result;
}
function assess(w: any, weight: number) {
  const wind = band(w.wind_mph, [25, 35, 45, 55]);
  const rain = band(w.rain_in_hr, [0.1, 0.25, 0.5, 1], true);
  const snow = band(w.snow_in_hr, [0.5, 1, 2, 3], true);
  const load =
    w.wind_mph >= 55 || (w.wind_mph >= 45 && weight > 30000)
      ? 4
      : w.wind_mph >= 35 && w.wind_mph < 45 && weight > 40000
        ? 3
        : 0;
  const worst = Math.max(wind ?? 0, rain ?? 0, snow ?? 0, load);
  return {
    complete: wind !== null && rain !== null && snow !== null,
    level: worst === 4 || (wind !== null && rain !== null && snow !== null) ? levels[worst] : 'unknown',
  };
}
async function record(id: string, suffix: string, data: unknown) {
  const directory = resolve(process.cwd(), '../.cache/qa/live-trip-records');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${id}-${suffix}.json`), JSON.stringify(data, null, 2));
}
async function chooseLivePlace(page: Page, caseId: string, label: string) {
  const option = page.getByRole('option', { name: label, exact: true }).first();
  const retry = page.getByRole('button', { name: 'Retry location search', exact: true });
  await expect
    .poll(async () => (await option.isVisible()) || (await retry.isVisible()), { timeout: 35000 })
    .toBe(true);
  if (await retry.isVisible()) {
    await record(caseId, 'location-retry', {
      label,
      errors: await page.getByRole('alert').allTextContents(),
    });
    await retry.click();
  }
  await option.click({ timeout: 35000 });
}
async function submit(page: Page, id: string, suffix = 'analysis') {
  const pending = page.waitForResponse(
    (r) => r.url().endsWith('/api/analyses') && r.request().method() === 'POST',
    { timeout: 150000 },
  );
  const started = Date.now();
  await page.getByRole('button', { name: /^(Find routes|Update route analysis)$/ }).click();
  const response = await pending;
  const result = await response.json();
  await record(id, suffix, {
    seconds: (Date.now() - started) / 1000,
    status: response.status(),
    request: response.request().postDataJSON(),
    result,
  });
  expect(response.status(), JSON.stringify(result)).toBe(200);
  expect(result.mode).toBe('live');
  expect(result).not.toHaveProperty('scenario');
  verifyAnalysis(result);
  return result;
}
function verifyAnalysis(a: any) {
  expect(a.routes.length).toBeGreaterThan(0);
  expect(a.routes.length).toBeLessThanOrEqual(3);
  for (const route of a.routes) {
    expect(route.checkpoints.length).toBe(Math.ceil(route.distance_m / (a.interval_miles * 1609.344)) + 1);
    const exposures: Record<string, number> = Object.fromEntries([...levels, 'unknown'].map((l) => [l, 0]));
    let weighted = 0;
    for (const [i, cp] of route.checkpoints.entries()) {
      const expected = assess(cp.weather, a.load_weight_lb);
      expect(cp.level).toBe(expected.level);
      expect(cp.complete).toBe(expected.complete);
      expect(new Date(cp.eta).getTime()).toBeCloseTo(
        new Date(a.departure_utc).getTime() + cp.elapsed_s * 1000,
        -1,
      );
      if (i < route.checkpoints.length - 1)
        expect(cp.distance_m).toBeCloseTo(i * a.interval_miles * 1609.344, 3);
      const length = Math.round(cp.exposure_end_m * 1000) - Math.round(cp.exposure_start_m * 1000);
      exposures[cp.level] += length;
      weighted += Math.max(0, levels.indexOf(cp.level)) * length;
    }
    const total = Object.values(exposures).reduce((sum, n) => sum + n, 0);
    for (const level of [...levels, 'unknown'])
      expect(route.miles_by_level[level]).toBeCloseTo(exposures[level] / 1000 / 1609.344, 6);
    expect(total / 1000).toBeCloseTo(route.distance_m, 2);
    expect(route.checkpoints.at(-1).distance_m).toBe(route.distance_m);
    expect(route.status).toBe(
      exposures.no_travel > 0 ? 'blocked' : route.complete ? 'evaluated' : 'incomplete',
    );
    if (route.complete) expect(route.average_risk).toBeCloseTo(weighted / total, 9);
  }
  const eligible = a.routes.filter((r: any) => r.status === 'evaluated');
  eligible.sort((left: any, right: any) => {
    for (const key of ['severe', 'high']) {
      const difference = left.miles_by_level[key] - right.miles_by_level[key];
      if (difference) return difference;
    }
    return (
      left.average_risk - right.average_risk ||
      Math.round(left.duration_s * 1000) - Math.round(right.duration_s * 1000) ||
      left.id.localeCompare(right.id)
    );
  });
  expect(a.recommended_route_id).toBe(eligible[0]?.id ?? null);
}
const cases = [
  {
    id: 'L01',
    origin: 'Chicago',
    originLabel: 'Chicago, IL',
    destination: 'Milwaukee',
    destinationLabel: 'Milwaukee, WI',
    interval: 50,
  },
  {
    id: 'L02',
    origin: 'Rawlins',
    originLabel: 'Rawlins, WY',
    destination: 'Laramie',
    destinationLabel: 'Laramie, WY',
    interval: 10,
    departure: '2026-11-10T19:00',
    hazard: 'wind_mph',
    minimum: 25,
  },
  {
    id: 'L03',
    origin: 'Miami',
    originLabel: 'Miami, FL',
    destination: 'Fort Lauderdale',
    destinationLabel: 'Fort Lauderdale, FL',
    interval: 10,
    departure: '2026-11-09T04:00',
    hazard: 'rain_in_hr',
    minimum: 0.5,
  },
  {
    id: 'L04',
    origin: 'Truckee',
    originLabel: 'Truckee, CA',
    destination: 'Sacramento',
    destinationLabel: 'Sacramento, CA',
    interval: 10,
    departure: '2026-11-16T08:00',
    hazard: 'snow_in_hr',
    minimum: 0,
  },
  {
    id: 'L05',
    origin: 'Connecticut Farms',
    originLabel: 'Connecticut Farms, NJ',
    destination: 'North Dakota',
    destinationLabel: 'North Dakota',
    interval: 50,
  },
  {
    id: 'L06',
    origin: 'South Dakota',
    originLabel: 'South Dakota',
    destination: 'Connecticut Farms',
    destinationLabel: 'Connecticut Farms, NJ',
    interval: 25,
    departure: '2026-11-20T08:00',
    zone: 'America/Chicago',
    weight: 70990,
  },
  {
    id: 'L08',
    origin: 'Browning',
    originLabel: 'Browning, MT',
    destination: 'Cut Bank',
    destinationLabel: 'Cut Bank, MT',
    interval: 10,
    departure: '2026-11-08T21:00',
    weight: 40000,
    hazard: 'wind_mph',
    minimum: 35,
  },
];
for (const trip of cases) {
  test(`${trip.id} live ${trip.originLabel} to ${trip.destinationLabel}`, async ({
    page,
  }, info: TestInfo) => {
    const errors: string[] = [];
    const forbidden: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (r.url().endsWith('/api/analyses') && r.method() === 'POST' && r.postDataJSON().mode !== 'live')
        forbidden.push(r.postData() ?? '');
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Demo', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Scenario', { exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'FROM', exact: true }).fill(trip.origin);
    await chooseLivePlace(page, trip.id, trip.originLabel);
    await page.getByRole('combobox', { name: 'TO', exact: true }).fill(trip.destination);
    await chooseLivePlace(page, trip.id, trip.destinationLabel);
    if (trip.departure) {
      await page.getByLabel('DEPARTURE', { exact: true }).fill(trip.departure);
      await page.getByLabel('Departure timezone').selectOption(trip.zone ?? 'UTC');
    }
    await page.getByLabel('PAYLOAD WEIGHT', { exact: true }).fill(String(trip.weight ?? 28000));
    await page.getByRole('button', { name: `${trip.interval} mi`, exact: true }).click();
    let corridorData: any;
    page.on('response', async (response) => {
      if (response.url().endsWith('/corridor') && response.ok()) corridorData = await response.json();
    });
    const a = await submit(page, trip.id);
    console.log(
      JSON.stringify({
        case: trip.id,
        routes: a.routes.length,
        criterion: a.explanation.criterion,
        warnings: a.warnings,
        levels: a.routes.map((r: any) => r.worst_level),
      }),
    );
    if (trip.hazard) {
      const values = a.routes.flatMap((r: any) =>
        r.checkpoints.map((cp: any) => cp.weather[trip.hazard!] ?? 0),
      );
      const maximum = Math.max(...values);
      await record(trip.id, 'hazard-coverage', { field: trip.hazard, maximum, target: trip.minimum });
      expect(
        maximum,
        'Forecast changed or location/ETA missed target: leave this live weather case unverified.',
      ).toBeGreaterThan(trip.minimum!);
    }
    await expect(page.getByRole('slider')).toBeEnabled({ timeout: 60000 });
    await expect.poll(() => !!corridorData).toBe(true);
    await record(trip.id, 'corridor', corridorData);
    expect(corridorData.times).toHaveLength(49);
    corridorData.times.forEach((time: string, hour: number) =>
      expect(new Date(time).getTime()).toBe(new Date(a.departure_utc).getTime() + hour * 3600000),
    );
    for (const cell of corridorData.cells) {
      expect(cell.frames).toHaveLength(49);
      for (const [wind, rain, snow, risk] of cell.frames)
        expect(risk).toBe(
          assess({ wind_mph: wind, rain_in_hr: rain, snow_in_hr: snow }, a.load_weight_lb).level,
        );
    }
    let requests = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/')) requests++;
    });
    for (const layer of ['Wind', 'Rain', 'Snow', 'Risk']) {
      await page.getByRole('button', { name: layer, exact: true }).click();
      await expect(page.getByRole('button', { name: layer, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const legend =
        layer === 'Wind' ? 'WIND · MPH' : layer === 'Risk' ? 'RISK LEVEL' : `${layer.toUpperCase()} · IN/HR`;
      await expect(page.getByText(legend, { exact: true })).toBeVisible();
      for (const hour of ['0', '12', '24', '36', '48']) await page.getByRole('slider').fill(hour);
    }
    await page.getByRole('button', { name: 'Hide weather overlay' }).click();
    await page.getByRole('button', { name: 'Show weather overlay' }).click();
    expect(requests).toBe(0);
    await expect(page.getByRole('table')).toBeVisible();
    const displayed = a.routes.find((r: any) => r.id === a.recommended_route_id) ?? a.routes[0];
    const first = displayed.checkpoints[0];
    const cells = page.getByRole('table').getByRole('row').nth(1).getByRole('cell');
    for (const [index, field, digits] of [
      [3, 'wind_mph', 1],
      [4, 'rain_in_hr', 2],
      [5, 'snow_in_hr', 2],
    ] as const) {
      const value = first.weather[field];
      await expect(cells.nth(index)).toHaveText(value === null ? '—' : value.toFixed(digits));
    }
    await page.getByRole('table').getByRole('button', { name: '0', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Checkpoint details' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(panel).toContainText(`Mile ${trip.interval}`);
    await page.getByRole('button', { name: 'Close checkpoint details' }).click();
    for (const route of a.routes) {
      await page.getByRole('button', { name: `Select ${route.label}`, exact: true }).click();
      await expect(page.getByRole('table').getByRole('row')).toHaveCount(route.checkpoints.length + 1);
    }
    await expect(page.getByRole('slider')).toBeEnabled({ timeout: 60000 });
    await page.screenshot({ path: info.outputPath(`${trip.id}-live.jpg`) });
    if (trip.id === 'L01') {
      await page.getByRole('button', { name: 'Hide weather overlay' }).click();
      for (const interval of [10, 25]) {
        await page.getByRole('button', { name: `${interval} mi`, exact: true }).click();
        await submit(page, trip.id, `spacing-${interval}`);
      }
      for (const weight of [0, 30000, 30001, 40000, 40001, 70990, 80000]) {
        await page.getByLabel('PAYLOAD WEIGHT', { exact: true }).fill(String(weight));
        const next = await submit(page, trip.id, `payload-${weight}`);
        expect(next.load_weight_lb).toBe(weight);
      }
    }
    if (trip.id === 'L08') {
      const before = a.routes[0].checkpoints[0];
      expect(before.weather.wind_mph).toBeGreaterThanOrEqual(35);
      expect(before.weather.wind_mph).toBeLessThan(45);
      expect(before.level).toBe('high');
      await page.getByRole('table').getByRole('button', { name: '0', exact: true }).click();
      await page.getByRole('slider').fill('24');
      await page.getByLabel('PAYLOAD WEIGHT', { exact: true }).fill('40001');
      const after = await submit(page, trip.id, 'payload-40001');
      const checkpoint = after.routes[0].checkpoints[0];
      expect(checkpoint.weather.wind_mph).toBeCloseTo(before.weather.wind_mph, 8);
      expect(checkpoint.level).toBe('severe');
      await expect(page.getByRole('complementary', { name: 'Checkpoint details' })).toHaveCount(0);
      await expect(page.getByRole('slider')).toHaveValue('0');
      await record(trip.id, 'load-escalation', {
        wind_mph: before.weather.wind_mph,
        before: { payload: 40000, level: before.level },
        after: { payload: 40001, level: checkpoint.level },
      });
    }
    expect(forbidden).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test.describe('Live mobile workflow', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('L07 live mobile map, table, layers and keyboard location selection', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    const origin = page.getByRole('combobox', { name: 'FROM', exact: true });
    await origin.fill('Chicago');
    await expect(page.getByRole('option', { name: 'Chicago, IL', exact: true }).first()).toBeVisible();
    await origin.press('ArrowDown');
    await origin.press('Enter');
    await expect(origin).toHaveValue('Chicago, IL');
    await page.getByRole('combobox', { name: 'TO', exact: true }).fill('Milwaukee');
    await page.getByRole('option', { name: 'Milwaukee, WI', exact: true }).first().click();
    await page.getByRole('button', { name: '50 mi', exact: true }).click();
    const analysis = await submit(page, 'L07');
    expect(analysis.routes).toHaveLength(3);
    await page.getByRole('button', { name: 'Map & forecast', exact: true }).click();
    await expect(page.getByRole('slider')).toBeEnabled({ timeout: 60000 });
    for (const layer of ['Wind', 'Rain', 'Snow', 'Risk']) {
      await page.getByRole('button', { name: layer, exact: true }).click();
      await page.getByRole('slider').fill('48');
      await page.getByRole('slider').fill('0');
    }
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    const bounds = await page.getByRole('region', { name: 'Route comparison map' }).boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width / 2 + 60, bounds!.y + bounds!.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Fit all routes', exact: true }).click();
    await page.getByRole('table').getByRole('button', { name: '0', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: 'Checkpoint details' });
    await expect(inspector.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
    await inspector.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(inspector).toContainText('Mile 50');
    await page.getByRole('button', { name: 'Close checkpoint details' }).click();
    await page.screenshot({ path: info.outputPath('L07-live-mobile.jpg') });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await page.getByRole('button', { name: 'Plan & compare', exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await page.getByRole('button', { name: 'Map & forecast', exact: true }).click();
    }
    expect(errors).toEqual([]);
  });
});
