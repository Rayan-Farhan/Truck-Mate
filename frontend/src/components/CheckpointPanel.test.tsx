import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckpointPanel } from './CheckpointPanel';
import type { Analysis, Checkpoint, Route } from '../types';

afterEach(cleanup);

it('explains missing forecasts without claiming there are no hazards', () => {
  const checkpoint: Checkpoint = {
    sequence: 0,
    coordinates: [-100, 40],
    distance_m: 0,
    elapsed_s: 0,
    eta: '2026-11-09T14:00:00Z',
    level: 'unknown',
    complete: false,
    reasons: [],
    weather: {
      wind_mph: null,
      gust_mph: null,
      rain_in_hr: null,
      snow_in_hr: null,
      interval_start: null,
      interval_end: null,
    },
    levels: { wind: 'unknown', rain: 'unknown', snow: 'unknown' },
    exposure_start_m: 0,
    exposure_end_m: 1000,
  };
  render(
    <CheckpointPanel
      analysis={{ timezone: 'America/Chicago' } as Analysis}
      route={{ checkpoints: [checkpoint] } as Route}
      index={0}
      onClose={vi.fn()}
      onIndex={vi.fn()}
    />,
  );
  expect(screen.getByText(/Forecast data is incomplete/)).toBeInTheDocument();
  expect(screen.queryByText(/No elevated hazards/)).not.toBeInTheDocument();
});
