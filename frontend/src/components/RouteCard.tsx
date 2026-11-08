import { ArrowUpRight, Check, Clock3, ShieldAlert } from 'lucide-react';
import type { Route } from '../types';
import { duration, exposure, levels, miles, riskColor, riskLabel } from '../format';
export function RouteCard({
  route,
  index,
  selected,
  recommended,
  onSelect,
}: {
  route: Route;
  index: number;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`route-card ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Select ${route.label}`}
    >
      <div className="route-card-top">
        <span className="route-number">0{index + 1}</span>
        <span className="route-name">{route.label}</span>
        {recommended ? (
          <span className="recommended-tag">
            <Check size={11} />
            Recommended
          </span>
        ) : route.status === 'blocked' ? (
          <span className="blocked-tag">
            <ShieldAlert size={11} />
            No Travel
          </span>
        ) : route.status === 'incomplete' ? (
          <span className="unknown-tag">Incomplete</span>
        ) : (
          <ArrowUpRight size={15} className="muted" />
        )}
      </div>
      <div className="route-stats">
        <span>
          <Clock3 size={13} />
          <strong>{duration(route.duration_s)}</strong>
        </span>
        <span>
          {miles(route.distance_m)}
          <small> mi</small>
        </span>
        <span className={`risk-text ${route.worst_level}`}>{riskLabel[route.worst_level]} peak</span>
      </div>
      <div className="exposure-bar" aria-label="Risk exposure by route distance">
        {levels.map(
          (level) =>
            route.miles_by_level[level] > 0 && (
              <span
                key={level}
                title={`${riskLabel[level]}: ${exposure(route.miles_by_level[level])} miles`}
                style={{
                  background: riskColor[level],
                  width: `${(route.miles_by_level[level] / (route.distance_m / 1609.344)) * 100}%`,
                }}
              />
            ),
        )}
      </div>
      <div className="route-exposure">
        <span>
          <i style={{ background: riskColor.severe }} />
          {exposure(route.miles_by_level.severe)} Severe mi
        </span>
        <span>
          <i style={{ background: riskColor.high }} />
          {exposure(route.miles_by_level.high)} High mi
        </span>
      </div>
    </button>
  );
}
