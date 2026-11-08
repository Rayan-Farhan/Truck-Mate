import { riskColor } from './format';
import type { Layer } from './types';

/** Raw-value color bins, not the authoritative trip classifier. */
export function weatherStyle(value: number | null, layer: Exclude<Layer, 'risk'>) {
  if (value === null) return { color: riskColor.unknown, opacity: 0.3 };
  const stops = layer === 'wind' ? [25, 35, 45, 55] : layer === 'rain' ? [0.1, 0.25, 0.5, 1] : [0.5, 1, 2, 3];
  const band = stops.filter((stop, i) => (i === 3 && layer !== 'wind' ? value > stop : value >= stop)).length;
  const colors = [riskColor.low, riskColor.moderate, riskColor.high, riskColor.severe, riskColor.no_travel];
  return { color: colors[band], opacity: band === 0 ? 0.09 : 0.32 };
}
