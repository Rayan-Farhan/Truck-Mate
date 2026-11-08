export type Risk = 'low' | 'moderate' | 'high' | 'severe' | 'no_travel' | 'unknown';
export type Mode = 'live';
export interface Place {
  label: string;
  lat: number;
  lon: number;
}
export interface Weather {
  wind_mph: number | null;
  gust_mph: number | null;
  rain_in_hr: number | null;
  snow_in_hr: number | null;
  interval_start: string | null;
  interval_end: string | null;
}
export interface Checkpoint {
  sequence: number;
  coordinates: [number, number];
  distance_m: number;
  elapsed_s: number;
  eta: string;
  weather: Weather;
  level: Risk;
  complete: boolean;
  reasons: string[];
  levels: Record<string, Risk>;
  exposure_start_m: number;
  exposure_end_m: number;
}
export interface Route {
  id: string;
  label: string;
  road: string;
  coordinates: [number, number][];
  distance_m: number;
  duration_s: number;
  arrival_utc: string;
  eta_model: string;
  checkpoints: Checkpoint[];
  segments: GeoJSON.FeatureCollection<GeoJSON.LineString>;
  miles_by_level: Record<Risk, number>;
  average_risk: number | null;
  status: 'evaluated' | 'blocked' | 'incomplete';
  complete: boolean;
  worst_level: Risk;
}
export interface Analysis {
  id: string;
  mode: Mode;
  policy_version: string;
  created_at: string;
  forecast_retrieved_at?: string | null;
  departure_utc: string;
  timezone: string;
  load_weight_lb: number;
  interval_miles: 10 | 25 | 50;
  origin: Place;
  destination: Place;
  recommended_route_id: string | null;
  explanation: { criterion: string; text: string; difference?: number };
  warnings: string[];
  routes: Route[];
  data_note: string;
  vehicle_profile: { note: string };
}
export interface PlanRequest {
  mode: Mode;
  origin?: Place;
  destination?: Place;
  departure_local: string;
  timezone: string;
  utc_offset_minutes?: number;
  load_weight_lb: number;
  interval_miles: 10 | 25 | 50;
}
export interface Corridor {
  analysis_id: string;
  route_id: string;
  times: string[];
  resolution_miles: number;
  half_width_miles: number;
  fields: string[];
  cells: {
    id: number;
    geometry: GeoJSON.Geometry;
    coordinates: [number, number];
    frames: [number | null, number | null, number | null, Risk][];
  }[];
  warnings: string[];
}
export interface Briefing {
  source: 'bedrock' | 'groq' | 'calculated';
  text: string;
  model: string | null;
  note: string;
}
export interface Configuration {
  live_routing: boolean;
  bedrock: boolean;
  groq: boolean;
}
export type Layer = 'wind' | 'rain' | 'snow' | 'risk';
