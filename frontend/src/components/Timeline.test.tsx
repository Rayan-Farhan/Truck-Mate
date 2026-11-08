import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Timeline } from './Timeline';
import type { Corridor } from '../types';

afterEach(cleanup);
const corridor: Corridor = {
  analysis_id: 'a',
  route_id: 'r',
  times: Array.from({ length: 49 }, (_, i) => new Date(Date.UTC(2026, 10, 9, 14 + i)).toISOString()),
  resolution_miles: 15,
  half_width_miles: 20,
  fields: [],
  cells: [],
  warnings: [],
};
function setup(overrides = {}) {
  const onHour = vi.fn();
  render(
    <Timeline
      corridor={corridor}
      hour={0}
      onHour={onHour}
      visible
      onToggle={vi.fn()}
      zone="America/Chicago"
      loading={false}
      error={false}
      onRetry={vi.fn()}
      {...overrides}
    />,
  );
  return onHour;
}
describe('Forecast timeline', () => {
  it('starts at departure, not at now', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Departure' })).toBeInTheDocument();
    expect(screen.queryByText('now')).not.toBeInTheDocument();
  });
  it('exposes every hour including the 48-hour endpoint', () => {
    const onHour = setup();
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('max', '48');
    fireEvent.change(slider, { target: { value: '48' } });
    expect(onHour).toHaveBeenCalledWith(48);
  });
  it('disables unavailable frames', () => {
    setup({ corridor: undefined });
    expect(screen.getByRole('slider')).toBeDisabled();
  });
  it('provides retry when the independent forecast fails', () => {
    const retry = vi.fn();
    setup({ error: true, onRetry: retry });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('offers re-planning instead of repeating an expired corridor request', () => {
    const retry = vi.fn();
    const replan = vi.fn();
    setup({ error: true, expired: true, onRetry: retry, onReplan: replan });
    expect(screen.getByText(/This analysis has expired/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Re-run route analysis' }));
    expect(replan).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
