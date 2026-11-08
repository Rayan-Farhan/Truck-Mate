import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { MapBoundary } from './MapBoundary';
afterEach(cleanup);
it('keeps a usable explanation when map initialization fails', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  function BrokenMap() {
    throw new Error('WebGL unavailable');
    return null;
  }
  render(
    <MapBoundary>
      <BrokenMap />
    </MapBoundary>,
  );
  expect(screen.getByText('Map rendering is unavailable.')).toBeInTheDocument();
  expect(screen.getByText('Route comparison and the checkpoint table remain available.')).toBeInTheDocument();
  error.mockRestore();
});
