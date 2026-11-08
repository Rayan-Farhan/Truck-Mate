import { useEffect, useState, useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, MapPin } from 'lucide-react';
import { api } from '../api';
import type { Place } from '../types';

export function PlaceInput({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: Place;
  onChange: (value: Place) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value.label);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const id = useId();
  useEffect(() => setText(value.label), [value.label]);
  useEffect(() => {
    const handle = setTimeout(() => setSearch(text.trim()), 350);
    return () => clearTimeout(handle);
  }, [text]);
  const results = useQuery({
    queryKey: ['places', search],
    queryFn: ({ signal }) => api.places(search, signal),
    enabled: !disabled && open && search.length >= 3,
    retry: false,
  });
  // A new edit invalidates the previous query's suggestions immediately, before debounce.
  const searchCurrent = search === text.trim();
  const items = searchCurrent ? (results.data?.results ?? []) : [];
  const activeItem = open && !disabled && active >= 0 ? items[active] : undefined;
  function select(place: Place) {
    onChange(place);
    setText(place.label);
    setOpen(false);
    setActive(-1);
  }
  return (
    <div className="place-field">
      <label htmlFor={id}>{label}</label>
      <div className="place-input-wrap">
        <MapPin size={15} />
        <input
          id={id}
          role="combobox"
          autoComplete="off"
          aria-expanded={open && !disabled}
          aria-controls={`${id}-list`}
          aria-activedescendant={activeItem ? `${id}-option-${active}` : undefined}
          value={text}
          readOnly={disabled}
          onFocus={() => !disabled && setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          onChange={(e) => {
            setText(e.target.value);
            onChange({ label: e.target.value, lat: NaN, lon: NaN });
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === 'Escape') {
              setOpen(false);
              setActive(-1);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, items.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => (items.length ? Math.max(0, i - 1) : -1));
            }
            if (e.key === 'Enter' && open) {
              e.preventDefault();
              if (activeItem) select(activeItem);
              else if (searchCurrent && results.isError) void results.refetch();
            }
          }}
        />
        {results.isFetching && <LoaderCircle size={14} className="spin" />}
      </div>
      {open && !disabled && search.length >= 3 && (
        <div className="place-options" id={`${id}-list`} role="listbox" aria-label={`${label} suggestions`}>
          {items.map((item, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              id={`${id}-option-${i}`}
              key={`${item.lat}:${item.lon}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(item)}
            >
              <MapPin size={14} />
              {item.label}
            </button>
          ))}
          {searchCurrent && results.isError && (
            <>
              <p role="alert">
                {results.error instanceof Error
                  ? results.error.message
                  : 'Location search is temporarily unavailable.'}
              </p>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void results.refetch()}
              >
                Retry location search
              </button>
            </>
          )}
          {(!searchCurrent || results.isFetching) && <p>Searching locations…</p>}
          {searchCurrent && !results.isFetching && !results.isError && items.length === 0 && (
            <p>No matching places. Try a city and state.</p>
          )}
        </div>
      )}
    </div>
  );
}
