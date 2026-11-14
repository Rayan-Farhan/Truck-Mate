import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Compass,
  Layers3,
  LoaderCircle,
  Route as RouteIcon,
  ShieldCheck,
  Truck,
  X,
  AlertTriangle,
  Clock3,
} from 'lucide-react';
import { api, ApiError } from './api';
import type { Analysis, Layer, Place, PlanRequest } from './types';
import {
  duration,
  levels,
  measurement,
  miles,
  nextDeparture,
  riskColor,
  riskLabel,
  time,
  timezoneLabel,
} from './format';
import { PlaceInput } from './components/PlaceInput';
import { RouteCard } from './components/RouteCard';
const RouteMap = lazy(() => import('./components/RouteMap').then((module) => ({ default: module.RouteMap })));
import { Timeline } from './components/Timeline';
import { CheckpointPanel } from './components/CheckpointPanel';
import { MapBoundary } from './components/MapBoundary';
import { DriverBriefing } from './components/DriverBriefing';

const CHICAGO = { label: 'Chicago, IL', lat: 41.8781, lon: -87.6298 };
const DENVER = { label: 'Denver, CO', lat: 39.7392, lon: -104.9903 };
const DEFAULT: PlanRequest = {
  mode: 'live',
  origin: CHICAGO,
  destination: DENVER,
  departure_local: nextDeparture(),
  timezone: 'America/Chicago',
  load_weight_lb: 28000,
  interval_miles: 25,
};

function MethodDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="method-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>Route assessment</h2>
        <button className="icon-button" aria-label="Close methodology" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <p>Routes use forecasts at estimated checkpoint arrival times.</p>
      <ol>
        <li>Sample routes every 10, 25 or 50 miles, including both ends.</li>
        <li>Match arrival times to sustained wind and rain/snow intervals. Gusts are shown separately.</li>
        <li>Divide exposure at midpoints between checkpoints.</li>
        <li>
          Rank by fewest Severe miles, then High miles, then distance-weighted average risk, then travel time.
        </li>
      </ol>
      <p>The forecast slider changes the corridor overlay. Route colors use checkpoint arrival times.</p>
      <div className="method-warning">
        <ShieldCheck size={20} />
        <p>Routes with No Travel conditions or incomplete forecasts are excluded from recommendations.</p>
      </div>
      <h3>The assessment thresholds</h3>
      <table>
        <thead>
          <tr>
            <th>Level</th>
            <th>Wind mph</th>
            <th>Rain in/hr</th>
            <th>Snow in/hr</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Low', '<25', '<0.10', '<0.5'],
            ['Moderate', '25–<35', '0.10–<0.25', '0.5–<1'],
            ['High', '35–<45', '0.25–<0.50', '1–<2'],
            ['Severe', '45–<55', '0.50–1.00', '2–3'],
            ['No Travel', '≥55', '>1.00', '>3'],
          ].map((row) => (
            <tr key={row[0]}>
              {row.map((s, i) => (
                <td key={i}>{s}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        Wind 45–&lt;55 mph with payload &gt;30,000 lb becomes No Travel. Wind 35–&lt;45 mph with payload
        &gt;40,000 lb becomes Severe. Live routing assumes 35,000 lb tare and a 4.11 m × 2.6 m × 21.64 m
        vehicle. ETAs exclude driver breaks. Forecasts and sampled exposure cannot establish that a trip is
        safe.
      </p>
      <button className="primary-button" onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}

interface PlannerProps {
  initialPlan?: Partial<PlanRequest>;
  fleetLink?: string;
  onConfirmRoute?: (analysis: Analysis, route: Analysis['routes'][number]) => void;
}

export default function App({ initialPlan, fleetLink, onConfirmRoute }: PlannerProps = {}) {
  const [form, setForm] = useState<PlanRequest>({ ...DEFAULT, ...initialPlan });
  const [selectedId, setSelectedId] = useState('');
  const [hour, setHour] = useState(0);
  const [layer, setLayer] = useState<Layer>('wind');
  const [visible, setVisible] = useState(true);
  const [checkpoint, setCheckpoint] = useState<number | null>(null);
  const [method, setMethod] = useState(false);
  const [showTable, setShowTable] = useState(true);
  const [mobileTab, setMobileTab] = useState<'plan' | 'map'>('plan');
  const [validation, setValidation] = useState('');
  const [offset, setOffset] = useState<number | undefined>();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [submittedForm, setSubmittedForm] = useState<PlanRequest>(DEFAULT);
  const config = useQuery({ queryKey: ['config'], queryFn: ({ signal }) => api.config(signal) });
  const mutation = useMutation({
    mutationFn: api.analyze,
    onSuccess: (result, payload) => {
      setAnalysis(result);
      setSubmittedForm(payload);
      setSelectedId(result.recommended_route_id ?? result.routes[0]?.id ?? '');
      setCheckpoint(null);
      setHour(0);
      setOffset(undefined);
    },
  });
  const selected = analysis?.routes.find((r) => r.id === selectedId) ?? analysis?.routes[0];
  const corridor = useQuery({
    queryKey: ['corridor', analysis?.id, selected?.id],
    queryFn: ({ signal }) => api.corridor(analysis!.id, selected!.id, signal),
    enabled: !!analysis && !!selected && visible,
    retry: (count, error) => count < 1 && !(error instanceof ApiError && error.code === 'ANALYSIS_EXPIRED'),
  });
  const error = mutation.error;
  const offsetChoices =
    error instanceof ApiError
      ? (error.fields.utc_offset_minutes as { choices?: number[] } | undefined)?.choices
      : undefined;
  const comparableForm = (value: PlanRequest) => JSON.stringify({ ...value, utc_offset_minutes: undefined });
  const formChanged = !!analysis && comparableForm(form) !== comparableForm(submittedForm);
  function update<K extends keyof PlanRequest>(key: K, value: PlanRequest[K]) {
    setForm((old) => ({
      ...old,
      [key]: value,
    }));
    setValidation('');
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!Number.isFinite(form.load_weight_lb) || form.load_weight_lb < 0 || form.load_weight_lb > 80000) {
      setValidation('Enter a payload between 0 and 80,000 lb.');
      return;
    }
    if (!Number.isFinite(form.origin?.lat) || !Number.isFinite(form.destination?.lat)) {
      setValidation('Choose both locations from the search suggestions.');
      return;
    }
    setValidation('');
    mutation.mutate({ ...form, ...(offset === undefined ? {} : { utc_offset_minutes: offset }) });
  }
  function selectRoute(id: string) {
    setSelectedId(id);
    setCheckpoint(null);
  }
  const ranked = useMemo(() => analysis?.routes ?? [], [analysis]);
  const recommendation = analysis?.routes.find((r) => r.id === analysis.recommended_route_id);
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="TruckMate home">
          <span className="brand-mark">
            <svg viewBox="0 0 40 40" aria-hidden="true">
              <path d="M7 12h16v15H7zM23 18h6l5 6v3H23M23 24h11" />
              <circle cx="13" cy="29" r="3" />
              <circle cx="28" cy="29" r="3" />
            </svg>
          </span>
          <span>
            TruckMate<span className="brand-period">.</span>
          </span>
        </a>
        <div className="header-actions">
          <a className="help-button" href={fleetLink ?? '/fleet'}>
            {fleetLink ? 'Back to job' : 'Fleet sign-in'}
          </a>
          <button className="help-button" aria-label="How it works" onClick={() => setMethod(true)}>
            <CircleHelp size={16} />
            <span>How it works</span>
          </button>
        </div>
      </header>
      <div className="mobile-tabs">
        <button className={mobileTab === 'plan' ? 'active' : ''} onClick={() => setMobileTab('plan')}>
          <RouteIcon size={15} />
          Plan & compare
        </button>
        <button className={mobileTab === 'map' ? 'active' : ''} onClick={() => setMobileTab('map')}>
          <Compass size={15} />
          Map & forecast
        </button>
      </div>
      <main className="workspace">
        <aside className={`sidebar ${mobileTab === 'plan' ? 'mobile-active' : ''}`}>
          <h1 className="sr-only">Route planner</h1>
          {onConfirmRoute && selected && analysis && !formChanged && (
            <button className="help-button" type="button" onClick={() => onConfirmRoute(analysis, selected)}>
              Save selected route and ETA to job
            </button>
          )}
          <form onSubmit={submit} className="trip-form" aria-label="Trip planning form">
            {config.isSuccess && !config.data.live_routing && (
              <p className="configuration-note">
                Live routing is unavailable. Configure the routing provider to plan a trip.
              </p>
            )}
            <div className="places-stack">
              <span className="places-connector" />
              <PlaceInput
                label="FROM"
                value={form.origin ?? CHICAGO}
                onChange={(p: Place) => update('origin', p)}
                disabled={Boolean(initialPlan?.origin)}
              />
              <button
                type="button"
                className="swap-places"
                aria-label="Swap origin and destination"
                disabled={Boolean(initialPlan?.origin)}
                onClick={() => setForm((f) => ({ ...f, origin: f.destination, destination: f.origin }))}
              >
                <ArrowDownUp size={13} />
              </button>
              <PlaceInput
                label="TO"
                value={form.destination ?? DENVER}
                onChange={(p: Place) => update('destination', p)}
                disabled={Boolean(initialPlan?.destination)}
              />
            </div>
            <div className="form-label-row">
              <label htmlFor="departure">DEPARTURE</label>
              <span>{timezoneLabel(form.timezone)}</span>
            </div>
            <div className="date-input">
              <CalendarDays size={15} />
              <input
                id="departure"
                type="datetime-local"
                required
                value={form.departure_local}
                onChange={(e) => update('departure_local', e.target.value)}
              />
            </div>
            <label className="sr-only" htmlFor="timezone">
              Departure timezone
            </label>
            <select
              id="timezone"
              className="timezone-select"
              value={form.timezone}
              onChange={(e) => {
                update('timezone', e.target.value);
                setOffset(undefined);
              }}
            >
              {[
                ...new Set([
                  'America/Chicago',
                  'America/New_York',
                  'America/Denver',
                  'America/Los_Angeles',
                  'Asia/Karachi',
                  'UTC',
                  form.timezone,
                ]),
              ].map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
            <div className="form-label-row">
              <label htmlFor="weight">PAYLOAD WEIGHT</label>
              <Truck size={13} />
            </div>
            <div className="weight-input">
              <input
                id="weight"
                type="number"
                min={0}
                max={80000}
                step="any"
                required
                value={Number.isFinite(form.load_weight_lb) ? form.load_weight_lb : ''}
                readOnly={initialPlan?.load_weight_lb !== undefined}
                onChange={(e) =>
                  update('load_weight_lb', e.target.value === '' ? NaN : Number(e.target.value))
                }
              />
              <span>lb</span>
            </div>
            <div className="sampling-row">
              <span className="form-label">WEATHER CHECKPOINTS</span>
              <button
                type="button"
                className="subtle-button"
                onClick={() => setMethod(true)}
                aria-label="Explain checkpoint spacing"
              >
                <CircleHelp size={12} />
              </button>
            </div>
            <div className="interval-buttons">
              {([10, 25, 50] as const).map((n) => (
                <button
                  type="button"
                  key={n}
                  className={form.interval_miles === n ? 'active' : ''}
                  aria-pressed={form.interval_miles === n}
                  onClick={() => update('interval_miles', n)}
                >
                  {n}
                  <span> mi</span>
                  {form.interval_miles === n && <Check size={12} />}
                </button>
              ))}
            </div>
            {offsetChoices && (
              <label className="offset-select">
                This local time occurs twice. Choose UTC offset:
                <select value={offset ?? ''} onChange={(e) => setOffset(Number(e.target.value))}>
                  <option value="" disabled>
                    Select offset
                  </option>
                  {offsetChoices.map((n) => (
                    <option key={n} value={n}>
                      UTC{n >= 0 ? '+' : '−'}
                      {Math.abs(n) / 60}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(validation || error) && (
              <div className="form-error" role="alert">
                <AlertTriangle size={15} />
                <span>
                  {validation || error?.message}
                  {error instanceof ApiError && error.code === 'VALIDATION_ERROR' && (
                    <small>
                      {Object.entries(error.fields)
                        .filter(([k]) => k !== 'utc_offset_minutes')
                        .map(
                          ([k, v]) =>
                            `${k.replaceAll('_', ' ')}: ${Array.isArray(v) ? v.join(' ') : String(v)}`,
                        )
                        .join(' · ')}
                    </small>
                  )}
                </span>
              </div>
            )}
            <button className="primary-button plan-button" type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <LoaderCircle size={17} className="spin" />
                  Analyzing routes…
                </>
              ) : (
                <>
                  <RouteIcon size={16} />
                  {formChanged ? 'Update route analysis' : 'Find routes'}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <section className="comparison">
            <div className="section-label">
              <h2>Route comparison</h2>
              <span>{ranked.length} OPTIONS</span>
            </div>
            {ranked.length ? (
              ranked.map((route, index) => (
                <RouteCard
                  key={route.id}
                  route={route}
                  index={index}
                  selected={selected?.id === route.id}
                  recommended={analysis?.recommended_route_id === route.id}
                  onSelect={() => selectRoute(route.id)}
                />
              ))
            ) : (
              <div className="empty-comparison">
                <Compass size={22} />
                <p>No routes</p>
              </div>
            )}
          </section>
        </aside>
        <section
          className={`map-workspace ${mobileTab === 'map' ? 'mobile-active' : ''}`}
          aria-label="Trip analysis"
        >
          {mutation.isPending && analysis && (
            <div className="updating-banner" role="status">
              <LoaderCircle size={13} className="spin" />
              Updating analysis…
            </div>
          )}
          {mutation.isError && analysis && (
            <div className="updating-banner" role="status">
              <AlertTriangle size={13} />
              Update failed. Previous results shown.
            </div>
          )}
          <section className="map-info" aria-label="Map controls and route summary">
            <div className="map-topline">
              <span className="map-label">
                <RouteIcon size={13} /> {selected?.label ?? 'Route overview'}
              </span>
              {analysis && <span className="map-data-label">Live routing & forecasts</span>}
            </div>
            <div className="map-info-main">
              {analysis && (
                <div className={`recommendation-card ${!recommendation ? 'no-recommendation' : ''}`}>
                  <span className="recommendation-icon">
                    {recommendation ? <ShieldCheck size={19} /> : <AlertTriangle size={19} />}
                  </span>
                  <div>
                    <span className="eyebrow">
                      {recommendation ? 'RECOMMENDED ROUTE' : 'NO ELIGIBLE ROUTE'}
                    </span>
                    <strong>
                      {recommendation ? recommendation.label : 'Review conditions before travel'}
                    </strong>
                    <p>{analysis.explanation.text}</p>
                    {recommendation && (
                      <span className="recommendation-meta">
                        <Clock3 size={12} />
                        {duration(recommendation.duration_s)}
                        <i />
                        Arrive {time(recommendation.arrival_utc, analysis.timezone)}
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div className="layer-control">
                <span className="eyebrow">
                  <Layers3 size={12} />
                  WEATHER LAYER
                </span>
                <div>
                  {(['wind', 'rain', 'snow', 'risk'] as Layer[]).map((l) => (
                    <button
                      key={l}
                      className={layer === l ? 'active' : ''}
                      onClick={() => {
                        setLayer(l);
                        setVisible(true);
                      }}
                      aria-pressed={layer === l}
                    >
                      {l === 'risk' ? 'Risk' : l.charAt(0).toUpperCase() + l.slice(1)}
                    </button>
                  ))}
                </div>
                <span className="layer-unit">
                  {layer === 'wind'
                    ? 'Sustained wind · mph'
                    : layer === 'risk'
                      ? 'Load-adjusted risk'
                      : 'Hourly mean · in/hr'}
                </span>
              </div>
            </div>
            {analysis && (config.data?.bedrock || config.data?.groq) && (
              <DriverBriefing key={analysis.id} analysisId={analysis.id} />
            )}
            <div className="map-legend">
              <span>
                {layer === 'risk'
                  ? 'RISK LEVEL'
                  : layer === 'wind'
                    ? 'WIND · MPH'
                    : `${layer.toUpperCase()} · IN/HR`}
              </span>
              <div>
                {(layer === 'risk'
                  ? levels.slice(0, 5)
                  : layer === 'wind'
                    ? ['<25', '25–35', '35–45', '45–55', '55+']
                    : layer === 'rain'
                      ? ['<.10', '.10–.25', '.25–.50', '.50–1', '>1']
                      : ['<.5', '.5–1', '1–2', '2–3', '>3']
                ).map((s, i) => (
                  <span key={s}>
                    <i style={{ background: riskColor[levels[i]] }} />
                    {layer === 'risk' ? riskLabel[s as keyof typeof riskLabel] : s}
                  </span>
                ))}
                <span className="unknown-key">
                  <i />
                  Unknown
                </span>
              </div>
            </div>
          </section>
          <div className="map-frame">
            <MapBoundary>
              <Suspense
                fallback={
                  <div className="map-loading">
                    <LoaderCircle className="spin" size={20} />
                    Loading map…
                  </div>
                }
              >
                <RouteMap
                  analysis={analysis}
                  selectedId={selected?.id ?? ''}
                  corridor={corridor.data}
                  hour={hour}
                  layer={layer}
                  visible={visible}
                  onRoute={selectRoute}
                  onCheckpoint={setCheckpoint}
                />
              </Suspense>
            </MapBoundary>
            {checkpoint !== null && selected && analysis && (
              <CheckpointPanel
                analysis={analysis}
                route={selected}
                index={checkpoint}
                onClose={() => setCheckpoint(null)}
                onIndex={setCheckpoint}
              />
            )}
            {mutation.isPending && !analysis && (
              <div className="analysis-loading">
                <LoaderCircle size={27} className="spin" />
                <h3>Analyzing routes…</h3>
              </div>
            )}
          </div>
          <Timeline
            corridor={corridor.data}
            hour={hour}
            onHour={setHour}
            visible={visible}
            onToggle={() => setVisible((v) => !v)}
            zone={analysis?.timezone ?? form.timezone}
            loading={corridor.isFetching}
            error={corridor.isError}
            onRetry={() => void corridor.refetch()}
            expired={corridor.error instanceof ApiError && corridor.error.code === 'ANALYSIS_EXPIRED'}
            onReplan={() => mutation.mutate(submittedForm)}
            replanning={mutation.isPending}
          />
          {!!analysis?.warnings.length && (
            <div className="analysis-warnings" role="status">
              {analysis.warnings.map((w) => (
                <p key={w}>
                  <AlertTriangle size={13} />
                  {w}
                </p>
              ))}
            </div>
          )}
          {selected && analysis && (
            <section className="checkpoint-table">
              <h3>
                <button
                  type="button"
                  className="checkpoint-table-heading"
                  onClick={() => setShowTable((shown) => !shown)}
                  aria-expanded={showTable}
                  aria-controls="checkpoint-table-body"
                >
                  <span>{selected.label} · Checkpoints</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
              </h3>
              <div className="table-scroll" id="checkpoint-table-body" hidden={!showTable}>
                <table>
                  <thead>
                    <tr>
                      <th>Mile</th>
                      <th>Arrival · {timezoneLabel(analysis.timezone)}</th>
                      <th>Risk</th>
                      <th>Wind mph</th>
                      <th>Rain in/hr</th>
                      <th>Snow in/hr</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.checkpoints.map((cp) => (
                      <tr key={cp.sequence}>
                        <td>
                          <button
                            onClick={() => {
                              setCheckpoint(cp.sequence);
                              setMobileTab('map');
                            }}
                          >
                            {miles(cp.distance_m)} <ArrowUpRight size={10} />
                          </button>
                        </td>
                        <td>{time(cp.eta, analysis.timezone, true)}</td>
                        <td>
                          <span className={`risk-badge ${cp.level}`}>{riskLabel[cp.level]}</span>
                        </td>
                        <td>{measurement(cp.weather.wind_mph)}</td>
                        <td>{measurement(cp.weather.rain_in_hr, 2)}</td>
                        <td>{measurement(cp.weather.snow_in_hr, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </section>
      </main>
      {method && <MethodDialog onClose={() => setMethod(false)} />}
    </div>
  );
}
