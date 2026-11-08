import { describe, it, expect } from 'vitest';
import { duration, exposure, time, riskColor } from './format';
import { weatherStyle } from './weather-style';

describe('Driver-facing measurements', () => {
  it('carries rounded minutes into the next hour', () => expect(duration(7199)).toBe('2h 00m'));
  it('keeps a real small deciding exposure visible', () => expect(exposure(0.025)).toBe('<0.1'));
  it('shows an explicitly requested zone rather than the browser zone', () =>
    expect(time('2026-11-09T14:00:00Z', 'America/Chicago')).toBe('8:00 AM'));
});
describe('Weather color legend boundaries', () => {
  it('keeps exactly one inch of rain Severe', () =>
    expect(weatherStyle(1, 'rain').color).toBe(riskColor.severe));
  it('shows rain above one inch as No Travel', () =>
    expect(weatherStyle(1.001, 'rain').color).toBe(riskColor.no_travel));
  it('keeps exactly three inches of snow Severe', () =>
    expect(weatherStyle(3, 'snow').color).toBe(riskColor.severe));
  it('includes 55 mph in No Travel', () => expect(weatherStyle(55, 'wind').color).toBe(riskColor.no_travel));
  it('does not color missing weather as Low', () =>
    expect(weatherStyle(null, 'wind').color).toBe(riskColor.unknown));
});
