import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { PlaceInput } from './PlaceInput';

vi.mock('../api', () => ({ api: { places: vi.fn() } }));
const chicago = { label: 'Chicago, IL', lat: 41.8, lon: -87.6 };
const seattle = { label: 'Seattle, WA', lat: 47.6, lon: -122.3 };

function mount() {
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlaceInput label="FROM" value={chicago} onChange={onChange} />
    </QueryClientProvider>,
  );
  const input = screen.getByRole('combobox');
  fireEvent.focus(input);
  return { input, onChange };
}

beforeEach(() => vi.mocked(api.places).mockResolvedValue({ results: [] }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Place search keyboard selection', () => {
  it('shows the provider error and lets the user retry a failed search', async () => {
    vi.mocked(api.places).mockRejectedValueOnce(
      new Error('TomTom location search is temporarily unavailable.'),
    );
    vi.mocked(api.places).mockResolvedValue({ results: [seattle] });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('TomTom location search');
    fireEvent.click(screen.getByRole('button', { name: 'Retry location search' }));
    await screen.findByRole('option', { name: 'Seattle, WA' });
    expect(api.places).toHaveBeenCalledTimes(2);
  });
  it('keeps the input intact when Arrow Up and Enter are used with no results', async () => {
    const { input, onChange } = mount();
    await screen.findByText('No matching places. Try a city and state.');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(input).toHaveValue('Chicago, IL');
  });

  it('does not select a previous query result during debounce', async () => {
    vi.mocked(api.places).mockResolvedValue({ results: [seattle] });
    const { input, onChange } = mount();
    await screen.findByRole('option', { name: 'Seattle, WA' });
    fireEvent.change(input, { target: { value: 'Boston' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].label).toBe('Boston');
  });

  it('selects a valid result and clears the active descendant when closed', async () => {
    vi.mocked(api.places).mockResolvedValue({ results: [seattle] });
    const { input, onChange } = mount();
    await screen.findByRole('option', { name: 'Seattle, WA' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(seattle);
    expect(input).toHaveValue('Seattle, WA');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });
});
