import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import type { Place } from '../types';

export function DispatchMap({
  origin,
  destination,
  onOrigin,
  onDestination,
}: {
  origin?: Place;
  destination?: Place;
  onOrigin: (place: Place) => void;
  onDestination: (place: Place) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [target, setTarget] = useState<'pickup' | 'delivery'>('pickup');
  const [message, setMessage] = useState('');
  const selection = useRef({ target, onOrigin, onDestination });
  selection.current = { target, onOrigin, onDestination };

  useEffect(() => {
    if (!container.current) return;
    let instance: maplibregl.Map;
    try {
      instance = new maplibregl.Map({
        container: container.current,
        style: 'https://tiles.openfreemap.org/styles/dark',
        center: [-96, 40.7],
        zoom: 3.3,
        renderWorldCopies: false,
        attributionControl: { compact: true },
      });
    } catch {
      setMessage('Map unavailable. Choose both stops using address search.');
      return;
    }
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    instance.on('click', ({ lngLat }) => {
      const { lat, lng: lon } = lngLat.wrap();
      if (lat < 24 || lat > 50 || lon < -125 || lon > -66) {
        setMessage('Choose a stop within the planner’s US coverage.');
        return;
      }
      const { target, onOrigin, onDestination } = selection.current;
      const place = { label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon };
      if (target === 'pickup') {
        onOrigin(place);
        setTarget('delivery');
      } else {
        onDestination(place);
      }
      setMessage('');
    });
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const markers = [origin, destination].flatMap((place, index) => {
      if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return [];
      return [
        new maplibregl.Marker({ color: index ? '#d6b69d' : '#79a88e' })
          .setLngLat([place.lon, place.lat])
          .setPopup(new maplibregl.Popup().setText(place.label))
          .addTo(instance),
      ];
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [origin, destination]);

  return (
    <section className="fleet-dispatch-map">
      <h2>Pickup and delivery map</h2>
      <div className="fleet-actions">
        <button type="button" aria-pressed={target === 'pickup'} onClick={() => setTarget('pickup')}>
          Set pickup
        </button>
        <button type="button" aria-pressed={target === 'delivery'} onClick={() => setTarget('delivery')}>
          Set delivery
        </button>
      </div>
      <p>Choose a stop on the map or search for its address.</p>
      {message && <p role="status">{message}</p>}
      <div ref={container} className="fleet-map-canvas" aria-label="Dispatch map" />
    </section>
  );
}
