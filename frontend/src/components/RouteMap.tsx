import { useEffect, useRef, useState } from 'react';
import maplibregl, { type ExpressionSpecification, type GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, Feature, Geometry } from 'geojson';
import { Expand, Map as MapIcon } from 'lucide-react';
import type { Analysis, Corridor, Layer, Risk } from '../types';
import { riskColor, riskLabel } from '../format';
import { weatherStyle } from '../weather-style';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const COLORS = [
  'match',
  ['get', 'level'],
  'low',
  riskColor.low,
  'moderate',
  riskColor.moderate,
  'high',
  riskColor.high,
  'severe',
  riskColor.severe,
  'no_travel',
  riskColor.no_travel,
  'unknown',
  riskColor.unknown,
  riskColor.unknown,
] as ExpressionSpecification;
export function RouteMap({
  analysis,
  selectedId,
  corridor,
  hour,
  layer,
  visible,
  onRoute,
  onCheckpoint,
}: {
  analysis: Analysis | null;
  selectedId: string;
  corridor: Corridor | undefined;
  hour: number;
  layer: Layer;
  visible: boolean;
  onRoute: (id: string) => void;
  onCheckpoint: (index: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const callbacks = useRef({ onRoute, onCheckpoint });
  callbacks.current = { onRoute, onCheckpoint };
  const fitted = useRef('');
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [weatherTooltip, setWeatherTooltip] = useState<string | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [-96, 40.7],
      zoom: 4.3,
      attributionControl: { compact: true },
      renderWorldCopies: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    let fallback = false;
    map.on('error', () => {
      if (!map.isStyleLoaded() && !fallback) {
        fallback = true;
        setMapError(true);
        map.setStyle({
          version: 8,
          sources: {},
          layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#141414' } }],
        });
      }
    });
    map.on('style.load', () => {
      for (const id of ['weather', 'routes', 'segments', 'checkpoints', 'endpoints'])
        if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'weather-fill',
        type: 'fill',
        source: 'weather',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'] },
      });
      map.addLayer({
        id: 'weather-edge',
        type: 'line',
        source: 'weather',
        paint: { 'line-color': '#ffffff', 'line-width': 0.4, 'line-opacity': 0.12 },
      });
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'routes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#141414',
          'line-width': ['case', ['get', 'selected'], 9, 5],
          'line-opacity': 0.95,
        },
      });
      map.addLayer({
        id: 'route-outline',
        type: 'line',
        source: 'routes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#a6a49f',
          'line-width': ['case', ['get', 'selected'], 6, 3],
          'line-opacity': 0.6,
        },
      });
      map.addLayer({
        id: 'risk-lines',
        type: 'line',
        source: 'segments',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': COLORS,
          'line-width': ['case', ['get', 'selected'], 4.5, 2.6],
          'line-opacity': ['case', ['get', 'selected'], 1, 0.48],
        },
      });
      map.addLayer({
        id: 'checkpoints-circles',
        type: 'circle',
        source: 'checkpoints',
        paint: {
          'circle-color': COLORS,
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            3,
            ['case', ['get', 'selected'], 2, 1.7],
            7,
            ['case', ['get', 'selected'], 5, 1.7],
          ],
          'circle-stroke-color': '#1e1e1c',
          'circle-stroke-width': ['case', ['get', 'selected'], 1.3, 0.5],
          'circle-opacity': ['case', ['get', 'selected'], 1, 0.45],
        },
      });
      map.addLayer({
        id: 'endpoint-halo',
        type: 'circle',
        source: 'endpoints',
        paint: { 'circle-radius': 15, 'circle-color': '#b28d72', 'circle-opacity': 0.2 },
      });
      map.addLayer({
        id: 'endpoint-circles',
        type: 'circle',
        source: 'endpoints',
        paint: {
          'circle-radius': 7,
          'circle-color': '#b28d72',
          'circle-stroke-color': '#eeece6',
          'circle-stroke-width': 3,
        },
      });
      setReady(true);
    });
    map.on('click', 'route-outline', (e) => {
      const id = e.features?.[0]?.properties?.route_id;
      if (id) callbacks.current.onRoute(id);
    });
    map.on('click', 'checkpoints-circles', (e) => {
      const p = e.features?.[0]?.properties;
      if (p) {
        callbacks.current.onRoute(p.route_id);
        callbacks.current.onCheckpoint(Number(p.sequence));
      }
    });
    for (const id of ['route-outline', 'checkpoints-circles']) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
    map.on('mousemove', 'weather-fill', (e) => {
      const p = e.features?.[0]?.properties;
      if (p) setWeatherTooltip(`${p.display} · sampled corridor forecast`);
    });
    map.on('mouseleave', 'weather-fill', () => setWeatherTooltip(null));
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !analysis) return;
    const set = (id: string, data: FeatureCollection) => (map.getSource(id) as GeoJSONSource)?.setData(data);
    const outlines: Feature[] = [],
      risk: Feature[] = [],
      points: Feature[] = [];
    // Draw the selected path last so shared sections remain inspectable.
    const routes = [...analysis.routes].sort(
      (a, b) => Number(a.id === selectedId) - Number(b.id === selectedId),
    );
    for (const route of routes) {
      const selected = route.id === selectedId;
      outlines.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: route.coordinates },
        properties: { route_id: route.id, selected },
      });
      risk.push(...route.segments.features.map((f) => ({ ...f, properties: { ...f.properties, selected } })));
      points.push(
        ...route.checkpoints.map((cp) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: cp.coordinates },
          properties: { route_id: route.id, sequence: cp.sequence, level: cp.level, selected },
        })),
      );
    }
    set('routes', { type: 'FeatureCollection', features: outlines });
    set('segments', { type: 'FeatureCollection', features: risk });
    set('checkpoints', { type: 'FeatureCollection', features: points });
    set('endpoints', {
      type: 'FeatureCollection',
      features: [analysis.origin, analysis.destination].map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {},
      })),
    });
    if (fitted.current !== analysis.id) {
      fitted.current = analysis.id;
      const bounds = new maplibregl.LngLatBounds();
      analysis.routes.forEach((r) => r.coordinates.forEach((p) => bounds.extend(p)));
      map.fitBounds(bounds, {
        padding: 60,
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 800,
        maxZoom: 11,
      });
    }
  }, [analysis, selectedId, ready]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const features: Feature<Geometry>[] = [];
    if (visible && corridor && corridor.route_id === selectedId) {
      for (const cell of corridor.cells) {
        const values = cell.frames[hour];
        const index = { wind: 0, rain: 1, snow: 2, risk: 3 }[layer];
        const value = values[index];
        let color = riskColor.unknown,
          opacity = 0.3,
          display = 'Unknown';
        if (layer === 'risk') {
          color = riskColor[value as Risk] ?? riskColor.unknown;
          opacity = value === 'low' ? 0.07 : 0.3;
          display = riskLabel[value as Risk] ?? 'Unknown';
        } else if (typeof value === 'number') {
          const style = weatherStyle(value, layer as Exclude<Layer, 'risk'>);
          color = style.color;
          opacity = style.opacity;
          display = `${value.toFixed(layer === 'wind' ? 1 : 2)} ${layer === 'wind' ? 'mph' : 'in/hr'}`;
        }
        features.push({ type: 'Feature', geometry: cell.geometry, properties: { color, opacity, display } });
      }
    }
    (map.getSource('weather') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features });
  }, [corridor, hour, layer, visible, ready, selectedId]);
  function fit() {
    const map = mapRef.current;
    if (!map || !analysis) return;
    const bounds = new maplibregl.LngLatBounds();
    analysis.routes.forEach((r) => r.coordinates.forEach((p) => bounds.extend(p)));
    map.fitBounds(bounds, { padding: 70, duration: 400 });
  }
  return (
    <>
      <div className="map-canvas" ref={container} aria-label="Route comparison map" role="region" />
      {!ready && (
        <div className="map-loading">
          <MapIcon size={25} />
          <span>Loading map…</span>
        </div>
      )}
      {mapError && <div className="basemap-note">Basemap unavailable. Route geometry remains visible.</div>}
      {weatherTooltip && <div className="weather-tooltip">{weatherTooltip}</div>}
      <button className="fit-map" onClick={fit} title="Fit all routes" aria-label="Fit all routes">
        <Expand size={16} />
      </button>
    </>
  );
}
