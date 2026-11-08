import { ChevronLeft, ChevronRight, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import type { Corridor } from '../types';
import { time } from '../format';
export function Timeline({
  corridor,
  hour,
  onHour,
  visible,
  onToggle,
  zone,
  loading,
  error,
  onRetry,
  expired = false,
  onReplan,
  replanning = false,
}: {
  corridor: Corridor | undefined;
  hour: number;
  onHour: (h: number) => void;
  visible: boolean;
  onToggle: () => void;
  zone: string;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  expired?: boolean;
  onReplan?: () => void;
  replanning?: boolean;
}) {
  return (
    <section className="timeline" aria-label="Corridor forecast timeline">
      <div className="timeline-heading">
        <div>
          <span className="eyebrow">CORRIDOR FORECAST</span>
          <strong>
            {corridor
              ? time(corridor.times[hour], zone, true)
              : loading
                ? 'Loading forecast…'
                : '48-hour outlook'}
            <span className="timeline-offset">+{hour}h</span>
          </strong>
        </div>
        <div className="timeline-meta">
          {corridor && <span>{corridor.resolution_miles.toFixed(0)} mi grid · ±20 mi corridor</span>}
          <button
            className="icon-button"
            onClick={onToggle}
            aria-label={visible ? 'Hide weather overlay' : 'Show weather overlay'}
            aria-pressed={visible}
          >
            {visible ? <Eye size={17} /> : <EyeOff size={17} />}
          </button>
        </div>
      </div>
      {error ? (
        <div className="inline-error">
          {expired
            ? 'This analysis has expired. Re-run it to request new forecasts. Your displayed routes are unchanged.'
            : 'Corridor forecast unavailable. Your route analysis is unchanged.'}{' '}
          <button onClick={expired ? onReplan : onRetry} disabled={replanning}>
            {expired ? (replanning ? 'Re-running analysis…' : 'Re-run route analysis') : 'Retry'}
          </button>
        </div>
      ) : (
        <div className="scrubber">
          <button
            className="icon-button"
            onClick={() => onHour(Math.max(0, hour - 1))}
            disabled={!corridor || hour === 0}
            aria-label="Previous forecast hour"
          >
            <ChevronLeft size={17} />
          </button>
          <div className="range-track">
            <input
              type="range"
              min={0}
              max={48}
              step={1}
              value={hour}
              disabled={!corridor}
              onChange={(e) => onHour(Number(e.target.value))}
              aria-label="Forecast hour after departure"
              aria-valuetext={`Departure plus ${hour} hours`}
              style={{ '--progress': `${(hour / 48) * 100}%` } as React.CSSProperties}
            />
            <div className="time-ticks">
              {[0, 12, 24, 36, 48].map((t) => (
                <button key={t} disabled={!corridor} onClick={() => onHour(t)}>
                  {t === 0 ? 'Departure' : `+${t}h`}
                </button>
              ))}
            </div>
          </div>
          <button
            className="icon-button"
            onClick={() => onHour(Math.min(48, hour + 1))}
            disabled={!corridor || hour === 48}
            aria-label="Next forecast hour"
          >
            {loading ? <LoaderCircle size={16} className="spin" /> : <ChevronRight size={17} />}
          </button>
        </div>
      )}
    </section>
  );
}
