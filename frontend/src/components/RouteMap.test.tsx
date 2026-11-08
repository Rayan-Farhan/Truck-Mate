import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { validateStyleMin, type LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import { RouteMap } from './RouteMap';
import { riskColor } from '../format';
import type { Corridor } from '../types';

const engine = vi.hoisted(() => ({
  layers: [] as LayerSpecification[],
  styleLoaded: undefined as (() => void) | undefined,
  data: {} as Record<string, any>,
}));

vi.mock('maplibre-gl', () => ({
  default: {
    Map: class {
      addControl() {}
      on(event: string, handler: unknown) {
        if (event === 'style.load') engine.styleLoaded = handler as () => void;
      }
      getSource(id: string) {
        return {
          setData(data: unknown) {
            engine.data[id] = data;
          },
        };
      }
      addLayer(layer: LayerSpecification) {
        engine.layers.push(layer);
      }
      remove() {}
      resize() {}
    },
    NavigationControl: class {},
    ScaleControl: class {},
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  engine.layers = [];
  engine.data = {};
});

function overlayFixture(): Corridor {
  return {
    analysis_id: 'a',
    route_id: 'r',
    resolution_miles: 15,
    half_width_miles: 20,
    fields: ['wind_mph', 'rain_in_hr', 'snow_in_hr', 'risk'],
    warnings: [],
    times: Array.from({ length: 49 }, (_, i) => new Date(Date.UTC(2026, 10, 9, i)).toISOString()),
    cells: [
      {
        id: 0,
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-100, 40],
              [-99, 40],
              [-99, 41],
              [-100, 40],
            ],
          ],
        },
        coordinates: [-99.5, 40.5],
        frames: Array.from({ length: 49 }, (_, i) =>
          i === 48 ? [60, 1.1, 4, 'no_travel'] : [10, 0.2, 1.2, 'high'],
        ),
      },
    ],
  };
}

it('E01 E03 uses the selected hour and layer without changing the corridor geometry', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const corridor = overlayFixture();
  const props = {
    analysis: null,
    selectedId: 'r',
    corridor,
    hour: 0,
    layer: 'wind' as const,
    visible: true,
    onRoute: vi.fn(),
    onCheckpoint: vi.fn(),
  };
  const view = render(<RouteMap {...props} />);
  act(() => engine.styleLoaded?.());
  expect(engine.data.weather.features[0].properties.color).toBe(riskColor.low);
  expect(engine.data.weather.features[0].properties.display).toBe('10.0 mph');
  view.rerender(<RouteMap {...props} hour={48} />);
  expect(engine.data.weather.features[0].properties.color).toBe(riskColor.no_travel);
  expect(engine.data.weather.features[0].properties.display).toBe('60.0 mph');
  expect(engine.data.weather.features[0].geometry).toEqual(corridor.cells[0].geometry);
  view.rerender(<RouteMap {...props} layer="rain" />);
  expect(engine.data.weather.features[0].properties.color).toBe(riskColor.moderate);
  expect(engine.data.weather.features[0].properties.display).toBe('0.20 in/hr');
  view.rerender(<RouteMap {...props} layer="snow" />);
  expect(engine.data.weather.features[0].properties.color).toBe(riskColor.high);
  view.rerender(<RouteMap {...props} layer="risk" />);
  expect(engine.data.weather.features[0].properties.display).toBe('High');
});

it('E04 E05 keeps missing cells gray and clears the overlay when hidden or on another route', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const corridor = overlayFixture();
  corridor.cells[0].frames[0] = [null, null, null, 'unknown'];
  const props = {
    analysis: null,
    selectedId: 'r',
    corridor,
    hour: 0,
    layer: 'wind' as const,
    visible: true,
    onRoute: vi.fn(),
    onCheckpoint: vi.fn(),
  };
  const view = render(<RouteMap {...props} />);
  act(() => engine.styleLoaded?.());
  expect(engine.data.weather.features[0].properties.color).toBe(riskColor.unknown);
  expect(engine.data.weather.features[0].properties.display).toBe('Unknown');
  view.rerender(<RouteMap {...props} visible={false} />);
  expect(engine.data.weather.features).toEqual([]);
  view.rerender(<RouteMap {...props} selectedId="another-route" />);
  expect(engine.data.weather.features).toEqual([]);
  view.rerender(<RouteMap {...props} />);
  expect(engine.data.weather.features).toHaveLength(1);
});

it('registers map layers with expressions accepted by the MapLibre validator', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  render(
    <RouteMap
      analysis={null}
      selectedId=""
      corridor={undefined}
      hour={0}
      layer="wind"
      visible
      onRoute={vi.fn()}
      onCheckpoint={vi.fn()}
    />,
  );
  act(() => engine.styleLoaded?.());
  expect(engine.layers).toHaveLength(8);
  const sources = Object.fromEntries(
    ['weather', 'routes', 'segments', 'checkpoints', 'endpoints'].map((id) => [
      id,
      {
        type: 'geojson' as const,
        data: { type: 'FeatureCollection' as const, features: [] },
      },
    ]),
  );
  expect(
    validateStyleMin({ version: 8, sources, layers: engine.layers }).map((error) => error.message),
  ).toEqual([]);
});
