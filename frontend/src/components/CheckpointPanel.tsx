import { ArrowRight, CloudRain, Snowflake, Wind, X, MapPin } from 'lucide-react';
import type { Analysis, Route } from '../types';
import { measurement, miles, riskLabel, time, timezoneLabel } from '../format';
export function CheckpointPanel({
  analysis,
  route,
  index,
  onClose,
  onIndex,
}: {
  analysis: Analysis;
  route: Route;
  index: number;
  onClose: () => void;
  onIndex: (n: number) => void;
}) {
  const cp = route.checkpoints[Math.min(index, route.checkpoints.length - 1)];
  return (
    <aside className="checkpoint-panel" aria-label="Checkpoint details">
      <div className="inspector-heading">
        <span>
          <MapPin size={14} />
          CHECKPOINT {String(cp.sequence + 1).padStart(2, '0')}
        </span>
        <button className="icon-button" aria-label="Close checkpoint details" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="checkpoint-title">
        <h3>Mile {miles(cp.distance_m)}</h3>
        <span className={`risk-badge ${cp.level}`}>{riskLabel[cp.level]}</span>
      </div>
      <p className="checkpoint-arrival">
        Arrive {time(cp.eta, analysis.timezone, true)} · {timezoneLabel(analysis.timezone)}
      </p>
      <div className="weather-readings">
        <div>
          <Wind size={17} />
          <span>
            Wind
            <strong>
              {measurement(cp.weather.wind_mph)} <small>mph</small>
            </strong>
          </span>
        </div>
        <div>
          <CloudRain size={17} />
          <span>
            Rain
            <strong>
              {measurement(cp.weather.rain_in_hr, 2)} <small>in/hr</small>
            </strong>
          </span>
        </div>
        <div>
          <Snowflake size={17} />
          <span>
            Snow
            <strong>
              {measurement(cp.weather.snow_in_hr, 2)} <small>in/hr</small>
            </strong>
          </span>
        </div>
      </div>
      <p className="inspector-note">
        Gusts {measurement(cp.weather.gust_mph)} mph ·{' '}
        {!cp.complete
          ? 'Forecast data is incomplete. Conditions cannot be fully assessed.'
          : cp.reasons.length
            ? `Driven by ${cp.reasons.map((r) => (r === 'load' ? 'wind + load' : r)).join(', ')}.`
            : 'No elevated hazards at this sample.'}
      </p>
      <div className="inspector-nav">
        <button onClick={() => onIndex(Math.max(0, index - 1))} disabled={index === 0}>
          Previous
        </button>
        <span>
          {index + 1} / {route.checkpoints.length}
        </span>
        <button
          onClick={() => onIndex(Math.min(route.checkpoints.length - 1, index + 1))}
          disabled={index === route.checkpoints.length - 1}
        >
          Next <ArrowRight size={12} />
        </button>
      </div>
    </aside>
  );
}
