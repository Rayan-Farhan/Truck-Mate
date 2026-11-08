import type { Risk } from './types';
export const MILE = 1609.344;
export const levels: Risk[] = ['low', 'moderate', 'high', 'severe', 'no_travel', 'unknown'];
export const riskLabel: Record<Risk, string> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  severe: 'Severe',
  no_travel: 'No Travel',
  unknown: 'Unknown',
};
export const riskColor: Record<Risk, string> = {
  low: '#79a88e',
  moderate: '#d2b56f',
  high: '#dd9b65',
  severe: '#da8076',
  no_travel: '#b39bd0',
  unknown: '#a6a49f',
};
export const miles = (meters: number) => Math.round(meters / MILE).toLocaleString('en-US');
export const exposure = (value: number) => (value > 0 && value < 0.1 ? '<0.1' : value.toFixed(1));
export function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
export function time(iso: string, zone: string, full = false) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    ...(full ? { month: 'short', day: 'numeric' } : {}),
  }).format(new Date(iso));
}
export function timezoneLabel(zone: string) {
  return zone.split('/').pop()?.replaceAll('_', ' ') ?? zone;
}
export const measurement = (value: number | null, digits = 1) =>
  value === null ? '—' : value.toFixed(digits);
export function nextDeparture() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T08:00`;
}
