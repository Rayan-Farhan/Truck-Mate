"""Live provider adapters. No fixture fallback is ever used for a live request."""

from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import hashlib
import json
import logging
from math import isfinite
from time import monotonic
from threading import Lock
from urllib.parse import quote

import httpx
from django.conf import settings
from django.core.cache import cache

from .geometry import (
    cumulative,
    distinct,
    route_identity,
    corridor_waypoints,
    retraces_road,
    GEOD,
)

UTC = timezone.utc
CLIENT = httpx.Client(
    timeout=httpx.Timeout(12, connect=4, pool=3),
    limits=httpx.Limits(max_connections=8, max_keepalive_connections=6),
    headers={"User-Agent": "TruckMate-assessment/1.0", "Accept": "application/json"},
)
WEATHER_POOL = ThreadPoolExecutor(max_workers=3, thread_name_prefix="weather")
WEATHER_BUDGET_LOCK = Lock()
LOGGER = logging.getLogger(__name__)


def reserve_weather_locations(count):
    """Conservative per-location admission budget, shared by this worker's threads.

    This is not the provider's billing meter, and resets with the process cache.
    """
    now = datetime.now(UTC)
    periods = [
        (now.strftime("%Y%m%d%H%M"), settings.WEATHER_LOCATION_LIMIT_PER_MINUTE, 65),
        (now.strftime("%Y%m%d%H"), settings.WEATHER_LOCATION_LIMIT_PER_HOUR, 3605),
        (now.strftime("%Y%m%d"), settings.WEATHER_LOCATION_LIMIT_PER_DAY, 86405),
    ]
    with WEATHER_BUDGET_LOCK:
        counts = [
            (
                f"weather-budget:{period}",
                cache.get(f"weather-budget:{period}", 0),
                limit,
                ttl,
            )
            for period, limit, ttl in periods
        ]
        if any(used + count > limit for _, used, limit, _ in counts):
            return False
        for key, used, _, ttl in counts:
            cache.set(key, used + count, ttl)
    return True


class ServiceError(Exception):
    def __init__(self, code, message, status=503):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def get_json(url, params, *, timeout=None):
    service = (
        "TomTom route planning"
        if url.startswith("https://api.tomtom.com/routing/")
        else (
            "TomTom location search"
            if url.startswith("https://api.tomtom.com/search/")
            else (
                "Weather forecast service"
                if url == settings.OPEN_METEO_URL
                else "External service"
            )
        )
    )
    deadline = monotonic() + (12 if timeout is None else timeout)
    for attempt in range(2):
        remaining = max(0.01, deadline - monotonic())
        try:
            response = CLIENT.get(
                url,
                params=params,
                timeout=httpx.Timeout(
                    remaining, connect=min(4, remaining), pool=min(3, remaining)
                ),
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            LOGGER.warning(
                "%s returned HTTP %s (attempt %s)", service, status, attempt + 1
            )
            if status in (401, 403):
                raise ServiceError(
                    "PROVIDER_AUTH",
                    f"{service} rejected the configured credentials or account access. Check the server configuration.",
                ) from None
            if status == 429:
                raise ServiceError(
                    "PROVIDER_RATE_LIMIT",
                    f"{service} reached its request limit. Please retry later.",
                ) from None
            if status >= 500 and attempt == 0 and deadline - monotonic() >= 1:
                continue
            raise ServiceError(
                "PROVIDER_UNAVAILABLE",
                f"{service} is temporarily unavailable. Please retry shortly.",
            ) from None
        except (
            httpx.ConnectError,
            httpx.ConnectTimeout,
            httpx.ReadError,
            httpx.RemoteProtocolError,
        ) as exc:
            # Never log exception text or a request URL; either can contain keys.
            LOGGER.warning(
                "%s failed (%s, attempt %s)", service, type(exc).__name__, attempt + 1
            )
            if attempt == 0 and deadline - monotonic() >= 1:
                continue
            raise ServiceError(
                "PROVIDER_CONNECTION",
                f"{service} could not be reached after retrying. Please retry shortly.",
            ) from None
        except httpx.TimeoutException as exc:
            LOGGER.warning("%s timed out (%s)", service, type(exc).__name__)
            hint = (
                "Please retry; long-distance routes may take longer."
                if "/routing/" in url
                else "Please retry shortly."
            )
            raise ServiceError(
                "PROVIDER_TIMEOUT", f"{service} took too long to respond. {hint}"
            ) from None
        except (httpx.HTTPError, ValueError) as exc:
            LOGGER.warning(
                "%s returned an unusable response (%s)", service, type(exc).__name__
            )
            raise ServiceError(
                "PROVIDER_UNAVAILABLE",
                f"{service} returned an unusable response. Please retry shortly.",
            ) from None


def fingerprint(prefix, value):
    return (
        prefix
        + ":"
        + hashlib.sha256(
            json.dumps(value, sort_keys=True, default=str).encode()
        ).hexdigest()
    )


def places(query):
    if not settings.TOMTOM_API_KEY:
        raise ServiceError(
            "ROUTING_NOT_CONFIGURED",
            "Add TOMTOM_API_KEY to your private .env to search live locations.",
        )
    key = fingerprint("places-v2", query.strip().lower())
    if (saved := cache.get(key)) is not None:
        return saved
    data = get_json(
        f'https://api.tomtom.com/search/2/geocode/{quote(query, safe="")}.json',
        {"key": settings.TOMTOM_API_KEY, "limit": 5, "countrySet": "US"},
    )
    result = []
    for item in data.get("results", []):
        address = item["address"]
        label = address.get("freeformAddress", query)
        if item.get("entityType") == "CountrySecondarySubdivision":
            county = address.get("countrySecondarySubdivision")
            state = address.get("countrySubdivisionCode") or address.get(
                "countrySubdivision"
            )
            if county and state:
                suffix = "Parish" if state == "LA" else "County"
                label = f"{county} {suffix}, {state}"
        result.append(
            {
                "label": label,
                "lat": item["position"]["lat"],
                "lon": item["position"]["lon"],
            }
        )
    cache.set(key, result, 3600)
    return result


def _progress_values(coords, anchors, field, total):
    physical = cumulative(coords)
    valid = [
        (int(a["pointIndex"]), float(a[field]))
        for a in anchors
        if field in a and "pointIndex" in a
    ]
    if not valid:
        return [total * s / physical[-1] for s in physical], False
    if any(
        i < 0 or i >= len(coords) or not isfinite(value) or value < 0
        for i, value in valid
    ):
        raise ServiceError(
            "ROUTING_CONTRACT", "The routing service returned invalid travel progress."
        )
    valid = sorted(dict(valid).items())
    if valid[0][0] != 0 or valid[-1][0] != len(coords) - 1:
        raise ServiceError(
            "ROUTING_CONTRACT",
            "The routing service returned incomplete travel progress.",
        )
    if any(b[1] < a[1] for a, b in zip(valid, valid[1:])):
        raise ServiceError(
            "ROUTING_CONTRACT",
            "The routing service returned nonmonotonic travel progress.",
        )
    output = [0.0] * len(coords)
    for (a, av), (b, bv) in zip(valid, valid[1:]):
        span = physical[b] - physical[a]
        for i in range(a, b + 1):
            fraction = (
                (physical[i] - physical[a]) / span if span else (i - a) / max(1, b - a)
            )
            output[i] = av + (bv - av) * fraction
    return output, True


def parse_tomtom(item):
    coords, distances, times = [], [], []
    offset_d = offset_t = 0.0
    precise = True
    for leg in item.get("legs", []):
        points = [
            [float(p["longitude"]), float(p["latitude"])] for p in leg.get("points", [])
        ]
        if len(points) < 2:
            raise ServiceError(
                "ROUTING_CONTRACT", "A route is missing its road geometry."
            )
        if any(not (-180 <= lon <= 180 and -85 <= lat <= 85) for lon, lat in points):
            raise ServiceError("ROUTING_CONTRACT", "A route has invalid coordinates.")
        if cumulative(points)[-1] <= 0:
            raise ServiceError(
                "ROUTING_CONTRACT", "A route has no measurable road distance."
            )
        summary = leg["summary"]
        anchors = leg.get("progress", summary.get("progress", []))
        ds, _ = _progress_values(
            points, anchors, "distanceInMeters", float(summary["lengthInMeters"])
        )
        ts, supported = _progress_values(
            points,
            anchors,
            "travelTimeInSeconds",
            float(summary["travelTimeInSeconds"]),
        )
        precise &= supported
        skip = 1 if coords and coords[-1] == points[0] else 0
        coords.extend(points[skip:])
        distances.extend(offset_d + d for d in ds[skip:])
        times.extend(offset_t + t for t in ts[skip:])
        offset_d += ds[-1]
        offset_t += ts[-1]
    # TomTom's extended representation lives on the route, with global polyline indices.
    if item.get("progress"):
        summary = item["summary"]
        distances, _ = _progress_values(
            coords,
            item["progress"],
            "distanceInMeters",
            float(summary["lengthInMeters"]),
        )
        times, precise = _progress_values(
            coords,
            item["progress"],
            "travelTimeInSeconds",
            float(summary["travelTimeInSeconds"]),
        )
        offset_d, offset_t = distances[-1], times[-1]
    # Remove zero-length duplicate vertices without discarding accumulated elapsed time.
    cleaned = []
    for point, distance, elapsed in zip(coords, distances, times):
        if cleaned and distance <= cleaned[-1][1]:
            cleaned[-1] = (point, distance, elapsed)
        else:
            cleaned.append((point, distance, elapsed))
    if len(cleaned) < 2 or offset_d <= 1 or offset_t <= 0:
        raise ServiceError("NO_ROUTE", "No usable road route was returned.", 422)
    return {
        "id": route_identity(coords),
        "coordinates": [p[0] for p in cleaned],
        "distances": [p[1] for p in cleaned],
        "times": [p[2] for p in cleaned],
        "distance_m": offset_d,
        "duration_s": offset_t,
        "eta_model": "provider_progress" if precise else "proportional_estimate",
    }


@dataclass(frozen=True)
class RouteSearch:
    routes: list
    details: dict


def routes(origin, destination, departure, load):
    if not settings.TOMTOM_API_KEY:
        raise ServiceError(
            "ROUTING_NOT_CONFIGURED",
            "Live routing needs TOMTOM_API_KEY in your private .env. Demo scenarios remain available.",
        )
    key = fingerprint(
        "route-search-v3",
        [origin, destination, departure.isoformat(), load, "us-semi-v1"],
    )
    if (saved := cache.get(key)) is not None:
        return saved
    start = f"{origin['lat']},{origin['lon']}"
    finish = f"{destination['lat']},{destination['lon']}"
    location = f"{start}:{finish}"
    long_distance = (
        GEOD.inv(origin["lon"], origin["lat"], destination["lon"], destination["lat"])[
            2
        ]
        > 750000
    )
    initial_alternatives = "2" if long_distance else "5"
    params = [
        ("key", settings.TOMTOM_API_KEY),
        ("travelMode", "truck"),
        ("maxAlternatives", initial_alternatives),
        ("alternativeType", "anyRoute"),
        ("routeRepresentation", "polyline"),
        ("traffic", "true"),
        ("departAt", departure.isoformat()),
        ("vehicleWeight", str(round((load + 35000) * 0.45359237))),
        ("vehicleHeight", "4.11"),
        ("vehicleWidth", "2.6"),
        ("vehicleLength", "21.64"),
        ("extendedRouteRepresentation", "distance"),
        ("extendedRouteRepresentation", "travelTime"),
    ]
    # At most five logical route queries (each can retry one brief transport failure).
    # Optional searches stop admitting work after 32s.
    deadline = monotonic() + 32
    payload = get_json(
        f"https://api.tomtom.com/routing/1/calculateRoute/{location}/json",
        params,
        timeout=30 if long_distance else 12,
    )
    details = {
        "requests": 1,
        "provider_candidates": 0,
        "duplicates_rejected": 0,
        "detours_rejected": 0,
        "retraced_routes_rejected": 0,
        "invalid_candidates": 0,
        "failed_requests": 0,
        "stopped_reason": "request_limit",
        "initial_max_alternatives": int(initial_alternatives),
    }
    candidates = []

    def parse_candidates(response, via=False):
        for item in response.get("routes", []):
            details["provider_candidates"] += 1
            try:
                route = parse_tomtom(item)
            except (ServiceError, KeyError, ValueError, TypeError, IndexError):
                details["invalid_candidates"] += 1
                continue
            route["road"] = (
                "Truck route · alternate corridor"
                if via
                else "TomTom truck alternative"
            )
            candidates.append(route)

    parse_candidates(payload)
    if not candidates:
        raise ServiceError(
            "NO_ROUTE", "No truck route is available between these locations.", 422
        )
    baseline = min(
        candidates, key=lambda r: (r["duration_s"], r["distance_m"], r["id"])
    )
    result = []

    def accept_candidates():
        while candidates and len(result) < 3:
            candidates.sort(key=lambda r: (r["duration_s"], r["distance_m"], r["id"]))
            route = candidates.pop(0)
            if (
                route["distance_m"] > baseline["distance_m"] * 1.75
                or route["duration_s"] > baseline["duration_s"] * 2
            ):
                details["detours_rejected"] += 1
            elif retraces_road(route):
                details["retraced_routes_rejected"] += 1
            elif not distinct(route, result):
                details["duplicates_rejected"] += 1
            else:
                result.append(route)

    accept_candidates()
    for waypoint in corridor_waypoints(baseline):
        if len(result) == 3:
            break
        if details["requests"] >= 5:
            break
        remaining = deadline - monotonic()
        if remaining < 1:
            details["stopped_reason"] = "time_limit"
            break
        details["requests"] += 1
        # Circle waypoints permit a through-road anywhere in the search area;
        # full provider geometry and progress are recalculated for the whole trip.
        via_location = f"{start}:{waypoint}:{finish}"
        try:
            response = get_json(
                f"https://api.tomtom.com/routing/1/calculateRoute/{via_location}/json",
                params,
                timeout=min(5, remaining),
            )
        except ServiceError as exc:
            details["failed_requests"] += 1
            if exc.code in ("PROVIDER_AUTH", "PROVIDER_RATE_LIMIT"):
                details["stopped_reason"] = exc.code.lower()
                break
            continue
        parse_candidates(response, via=True)
        accept_candidates()
    if not result:
        raise ServiceError(
            "NO_ROUTE", "No usable truck route passed the route checks.", 422
        )
    if len(result) == 3:
        details["stopped_reason"] = "target_reached"
    for index, route in enumerate(result, 1):
        route["label"] = f"Route {index}"
    search = RouteSearch(result, details)
    cache.set(key, search, 600)
    return search


@dataclass(frozen=True)
class Forecast:
    times: list
    wind: list
    gust: list
    rain: list
    showers: list
    snow: list
    retrieved_at: str | None = None

    def sample(self, moment):
        empty = {
            "wind_mph": None,
            "gust_mph": None,
            "rain_in_hr": None,
            "snow_in_hr": None,
            "interval_start": None,
            "interval_end": None,
        }
        target = moment.timestamp()
        if not self.times or target < self.times[0] or target > self.times[-1]:
            return empty
        right = bisect_right(self.times, target)
        left = max(0, right - 1)
        hi = min(right, len(self.times) - 1)
        exact = target == self.times[left]
        interval = left if exact else hi
        if not exact and self.times[hi] - self.times[left] != 3600:
            return empty
        if interval and self.times[interval] - self.times[interval - 1] != 3600:
            return empty

        def convert(value, divisor):
            return (
                float(Decimal(str(value)) / Decimal(str(divisor)))
                if value is not None
                else None
            )

        def instant(values):
            if exact:
                return values[left]
            a, b = values[left], values[hi]
            return (
                None
                if a is None or b is None
                else a + (b - a) * (target - self.times[left]) / 3600
            )

        rain, showers = self.rain[interval], self.showers[interval]
        liquid = (
            None
            if rain is None or showers is None
            else Decimal(str(rain)) + Decimal(str(showers))
        )
        end = datetime.fromtimestamp(self.times[interval], UTC)
        return {
            "wind_mph": convert(instant(self.wind), 0.44704),
            "gust_mph": convert(self.gust[interval], 0.44704),
            "rain_in_hr": convert(liquid, 25.4),
            "snow_in_hr": convert(self.snow[interval], 2.54),
            "interval_start": (end - timedelta(hours=1)).isoformat(),
            "interval_end": end.isoformat(),
        }


def parse_forecast(block):
    h, units = block.get("hourly", {}), block.get("hourly_units", {})
    expected = {
        "wind_speed_10m": "m/s",
        "wind_gusts_10m": "m/s",
        "rain": "mm",
        "showers": "mm",
        "snowfall": "cm",
    }
    if any(units.get(k) != v for k, v in expected.items()):
        raise ServiceError(
            "WEATHER_UNITS", "The weather provider returned unexpected units."
        )
    ts = h.get("time", [])
    if (
        not ts
        or any(not isinstance(t, (int, float)) or not isfinite(t) for t in ts)
        or any(b <= a for a, b in zip(ts, ts[1:]))
    ):
        raise ServiceError(
            "WEATHER_CONTRACT", "The weather provider returned invalid timestamps."
        )
    values = []
    for field in expected:
        rows = h.get(field, [])
        if len(rows) != len(ts) or any(
            v is not None
            and (not isinstance(v, (int, float)) or not isfinite(v) or v < 0)
            for v in rows
        ):
            raise ServiceError(
                "WEATHER_CONTRACT",
                "The weather provider returned incomplete measurements.",
            )
        values.append(rows)
    return Forecast(ts, *values, retrieved_at=datetime.now(UTC).isoformat())


def fetch_weather(points, start, end):
    """Cache exact canonical positions. Failed batches stay unknown; never zero-fill."""
    first = start.replace(hour=0, minute=0, second=0, microsecond=0)
    last = (end + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    cells = [(round(p[0], 6), round(p[1], 6)) for p in points]
    resolved, missing, warnings = {}, [], []
    for cell in dict.fromkeys(cells):
        key = fingerprint(
            "weather",
            [cell, first.isoformat(), last.isoformat(), settings.OPEN_METEO_URL],
        )
        saved = cache.get(key)
        if saved is not None:
            resolved[cell] = saved
        else:
            missing.append(cell)

    def chunk_request(chunk):
        params = {
            "longitude": ",".join(str(p[0]) for p in chunk),
            "latitude": ",".join(str(p[1]) for p in chunk),
            "hourly": "wind_speed_10m,wind_gusts_10m,rain,showers,snowfall",
            "wind_speed_unit": "ms",
            "precipitation_unit": "mm",
            "timezone": "UTC",
            "timeformat": "unixtime",
            "start_hour": first.strftime("%Y-%m-%dT%H:%M"),
            "end_hour": last.strftime("%Y-%m-%dT%H:%M"),
        }
        if settings.OPEN_METEO_API_KEY:
            params["apikey"] = settings.OPEN_METEO_API_KEY
        raw = get_json(settings.OPEN_METEO_URL, params)
        blocks = raw if isinstance(raw, list) else [raw]
        if len(blocks) != len(chunk):
            raise ServiceError(
                "WEATHER_CONTRACT",
                "The weather provider returned a different number of locations.",
            )
        return [parse_forecast(b) for b in blocks]

    chunks = [missing[i : i + 20] for i in range(0, len(missing), 20)]
    deadline = monotonic() + 25
    jobs = []
    for chunk in chunks:
        if reserve_weather_locations(len(chunk)):
            jobs.append((chunk, WEATHER_POOL.submit(chunk_request, chunk)))
        else:
            warnings.append(
                "The application forecast budget was reached. Unfetched locations remain Unknown; retry later or use a wider sampling interval."
            )
    for chunk, job in jobs:
        try:
            results = job.result(timeout=max(0.01, deadline - monotonic()))
            for cell, series in zip(chunk, results):
                resolved[cell] = series
                cache.set(
                    fingerprint(
                        "weather",
                        [
                            cell,
                            first.isoformat(),
                            last.isoformat(),
                            settings.OPEN_METEO_URL,
                        ],
                    ),
                    series,
                    900,
                )
        except (ServiceError, FutureTimeout, KeyError, TypeError, ValueError):
            job.cancel()
            warnings.append(
                "Some forecast locations could not be evaluated. Missing data is marked Unknown."
            )
    return [resolved.get(cell) for cell in cells], list(dict.fromkeys(warnings))
