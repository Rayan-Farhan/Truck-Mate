import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { RouteCard } from './RouteCard';
import type { Route } from '../types';
afterEach(cleanup);
const route = {
  id: 'r',
  label: 'Direct corridor',
  road: 'I-80',
  duration_s: 3600,
  distance_m: 160934.4,
  worst_level: 'no_travel',
  status: 'blocked',
  miles_by_level: { low: 50, moderate: 0, high: 0, severe: 0, no_travel: 50, unknown: 0 },
} as Route;
it('exposes No Travel and selection accessibly', () => {
  const choose = vi.fn();
  render(<RouteCard route={route} index={0} selected recommended={false} onSelect={choose} />);
  expect(screen.getByText('No Travel')).toBeInTheDocument();
  expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Select Direct corridor' });
  expect(button).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(button);
  expect(choose).toHaveBeenCalledOnce();
});
