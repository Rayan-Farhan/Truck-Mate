import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { api, ApiError } from './api';
import App from './App';
import type { Analysis, PlanRequest, Route } from './types';

vi.mock('./api', async (original) => {
  const module = await original<typeof import('./api')>();
  return {
    ...module,
    api: { config: vi.fn(), analyze: vi.fn(), corridor: vi.fn(), briefing: vi.fn(), places: vi.fn() },
  };
});
// Pure component integration: no browser, map engine, local page, or network access.
vi.mock('./components/RouteMap', () => ({
  RouteMap: ({ selectedId }: { selectedId: string }) => <div data-testid="map-selection">{selectedId}</div>,
}));

function fixture(payload: PlanRequest): Analysis {
  const blocked = payload.load_weight_lb === 30001;
  const level = blocked ? 'no_travel' : 'low';
  const routes = ['Direct corridor', 'Northern corridor', 'Southern corridor'].map((label, i) => ({
    id: `route-${i}`,
    label,
    road: 'Recorded fixture',
    coordinates: [
      [-100, 40],
      [-99, 40],
    ],
    distance_m: 160934.4,
    duration_s: 3600 + i * 600,
    arrival_utc: '2026-11-09T15:00:00Z',
    eta_model: 'fixture',
    checkpoints: [],
    segments: { type: 'FeatureCollection', features: [] },
    miles_by_level: {
      low: blocked ? 0 : 100,
      moderate: 0,
      high: 0,
      severe: 0,
      no_travel: blocked ? 100 : 0,
      unknown: 0,
    },
    average_risk: blocked ? 4 : 0,
    status: blocked ? 'blocked' : 'evaluated',
    complete: true,
    worst_level: level,
  })) as Route[];
  return {
    id: `fixture-${payload.load_weight_lb}`,
    mode: payload.mode,
    policy_version: 'test',
    created_at: '2026-11-09T14:00:00Z',
    departure_utc: '2026-11-09T14:00:00Z',
    timezone: payload.timezone,
    load_weight_lb: payload.load_weight_lb,
    interval_miles: payload.interval_miles,
    origin: { label: 'Chicago, IL', lat: 41.8, lon: -87.6 },
    destination: { label: 'Denver, CO', lat: 39.7, lon: -104.9 },
    recommended_route_id: blocked ? null : 'route-1',
    explanation: {
      criterion: blocked ? 'no_eligible_route' : 'severe_miles',
      text: blocked
        ? 'No route recommended. Every alternative contains No Travel conditions.'
        : 'Northern corridor has fewer Severe miles.',
    },
    warnings: [],
    routes,
    data_note: 'Synthetic fixture',
    vehicle_profile: { note: 'Fixture' },
  };
}

beforeEach(() => {
  vi.mocked(api.config).mockResolvedValue({
    live_routing: true,
    bedrock: false,
    groq: false,
  });
  vi.mocked(api.analyze).mockImplementation(async (payload) => fixture(payload));
  vi.mocked(api.corridor).mockImplementation(async (id, route) => ({
    analysis_id: id,
    route_id: route,
    times: Array.from({ length: 49 }, (_, i) => new Date(Date.UTC(2026, 10, 9, 14 + i)).toISOString()),
    resolution_miles: 15,
    half_width_miles: 20,
    fields: [],
    cells: [],
    warnings: [],
  }));
  vi.mocked(api.briefing).mockResolvedValue({
    source: 'calculated',
    text: 'The calculated route avoids elevated exposure.',
    model: null,
    note: 'Fixture',
  });
  vi.mocked(api.places).mockResolvedValue({ results: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function mount(plan = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  if (plan) fireEvent.click(screen.getByRole('button', { name: 'Find routes' }));
  return view;
}

describe('Planning workspace integration', () => {
  it('starts with a live planner and sends no automatic analysis request', () => {
    mount(false);
    expect(api.analyze).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Demo$/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scenario')).not.toBeInTheDocument();
  });
  it('submits a live request and synchronizes route selection', async () => {
    mount();
    await screen.findByText('Recommended', { exact: true });
    expect(screen.getByText('Live routing & forecasts', { exact: true })).toBeInTheDocument();
    expect(vi.mocked(api.analyze).mock.calls[0][0].mode).toBe('live');
    expect(vi.mocked(api.analyze).mock.calls[0][0]).not.toHaveProperty('scenario');
    const choice = screen.getByRole('button', { name: 'Select Southern corridor' });
    fireEvent.click(choice);
    expect(choice).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('map-selection')).toHaveTextContent('route-2');
  });
  it('submits updated values and never labels a blocked route recommended', async () => {
    mount();
    await screen.findByText('Recommended', { exact: true });
    fireEvent.change(screen.getByLabelText('PAYLOAD WEIGHT'), { target: { value: '30001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update route analysis' }));
    await screen.findByText('Review conditions before travel');
    expect(screen.queryByText('Recommended', { exact: true })).not.toBeInTheDocument();
    expect(vi.mocked(api.analyze).mock.calls.at(-1)?.[0].load_weight_lb).toBe(30001);
  });
  it('scrubs cached corridor frames without another forecast request', async () => {
    mount();
    const slider = await screen.findByRole('slider');
    await waitFor(() => expect(slider).toBeEnabled());
    const calls = vi.mocked(api.corridor).mock.calls.length;
    fireEvent.change(slider, { target: { value: '48' } });
    expect(slider).toHaveValue('48');
    expect(vi.mocked(api.corridor).mock.calls.length).toBe(calls);
  });
  it('keeps the previous analysis after a failed recalculation', async () => {
    mount();
    await screen.findByText('Recommended', { exact: true });
    vi.mocked(api.analyze).mockRejectedValueOnce(
      new ApiError('Provider temporarily unavailable', 'PROVIDER_UNAVAILABLE'),
    );
    fireEvent.change(screen.getByLabelText('PAYLOAD WEIGHT'), { target: { value: '28001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update route analysis' }));
    await screen.findByText('Provider temporarily unavailable');
    expect(screen.getByText('Recommended', { exact: true })).toBeInTheDocument();
  });
  it('generates a briefing on request and keeps the calculated recommendation visible', async () => {
    vi.mocked(api.config).mockResolvedValue({ live_routing: true, bedrock: true, groq: true });
    vi.mocked(api.briefing).mockResolvedValue({
      source: 'groq',
      model: 'test-model',
      text: 'Review the checkpoint weather before departing on the recommended corridor.',
      note: 'AI briefing',
    });
    mount();
    const button = await screen.findByRole('button', { name: 'Generate briefing' });
    expect(api.briefing).not.toHaveBeenCalled();
    fireEvent.click(button);
    await screen.findByText('AI briefing · Groq');
    expect(api.briefing).toHaveBeenCalledWith('fixture-28000', expect.any(AbortSignal));
    expect(screen.getByText('Northern corridor has fewer Severe miles.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select Southern corridor' }));
    expect(api.briefing).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('PAYLOAD WEIGHT'), { target: { value: '28001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update route analysis' }));
    await waitFor(() => expect(screen.queryByText('AI briefing · Groq')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Generate briefing' })).toBeInTheDocument();
  });
  it('labels a calculated fallback without claiming it is AI generated', async () => {
    vi.mocked(api.config).mockResolvedValue({ live_routing: true, bedrock: false, groq: true });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate briefing' }));
    await screen.findByText('Calculated explanation · AI briefing unavailable');
    expect(screen.getByText('The calculated route avoids elevated exposure.')).toBeInTheDocument();
    expect(screen.queryByText('AI briefing · Groq')).not.toBeInTheDocument();
  });
  it('allows a failed briefing to retry without recalculating the trip', async () => {
    vi.mocked(api.config).mockResolvedValue({ live_routing: true, bedrock: false, groq: true });
    vi.mocked(api.briefing).mockRejectedValueOnce(new Error('Network unavailable'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate briefing' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry briefing' }));
    await screen.findByText('Calculated explanation · AI briefing unavailable');
    expect(api.briefing).toHaveBeenCalledTimes(2);
    expect(api.analyze).toHaveBeenCalledTimes(1);
  });
});
