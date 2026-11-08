from datetime import datetime, timedelta, timezone
from uuid import uuid4
from functools import lru_cache
from threading import Lock

from django.core.cache import cache

from . import demo, providers
from .domain import POLICY_VERSION, assess, summarize, recommend, MILE_METERS
from .geometry import checkpoints, segments, corridor_cells

UTC = timezone.utc


@lru_cache(maxsize=128)
def _request_lock(key):
    return Lock()


def analyze(payload):
    key = providers.fingerprint("analysis-input-v3", payload)
    with _request_lock(key):
        saved_id = cache.get(key)
        saved = cache.get("analysis:" + saved_id) if saved_id else None
        if saved is not None:
            return saved
        result = _analyze(payload)
        cache.set(key, result["id"], 300)
        return result


def _analyze(payload):
    departure = payload["departure_utc"]
    mode, scenario = payload["mode"], payload["scenario"]
    route_search = None
    if mode == "demo":
        route_data = demo.routes()
    else:
        search = providers.routes(
            payload["origin"],
            payload["destination"],
            departure,
            payload["load_weight_lb"],
        )
        route_data, route_search = search.routes, search.details
    sampled = [checkpoints(route, payload["interval_miles"]) for route in route_data]
    if sum(len(rows) for rows in sampled) > 1200:
        raise providers.ServiceError(
            "POINT_BUDGET",
            "This trip exceeds the checkpoint budget. Choose a wider sampling interval.",
            422,
        )
    warnings = []
    series = []
    if mode == "live":
        end = departure + timedelta(seconds=max(r["duration_s"] for r in route_data))
        series, warnings = providers.fetch_weather(
            [cp["coordinates"] for rows in sampled for cp in rows], departure, end
        )
    routes, cursor = [], 0
    for route, samples in zip(route_data, sampled):
        for cp in samples:
            eta = departure + timedelta(seconds=cp["elapsed_s"])
            if mode == "demo":
                weather = demo.weather(cp["coordinates"], eta, departure, scenario)
            else:
                forecast = series[cursor]
                weather = (
                    forecast.sample(eta)
                    if forecast
                    else {
                        "wind_mph": None,
                        "gust_mph": None,
                        "rain_in_hr": None,
                        "snow_in_hr": None,
                        "interval_start": None,
                        "interval_end": None,
                    }
                )
                cursor += 1
            cp.update(
                eta=eta.isoformat(),
                weather=weather,
                **assess(weather, payload["load_weight_lb"]),
            )
        metrics = summarize(samples, route["distance_m"], route["duration_s"])
        routes.append(
            {
                **route,
                **metrics,
                "checkpoints": samples,
                "segments": segments(route, samples),
                "arrival_utc": (
                    departure + timedelta(seconds=route["duration_s"])
                ).isoformat(),
            }
        )
    recommended, explanation = recommend(routes)
    analysis_id = uuid4().hex
    if len(routes) < 3:
        warnings.append(
            f"Found {len(routes)} distinct truck routes within the bounded search. "
            "Other routes may exist; no paths were duplicated."
        )
        if route_search and route_search["stopped_reason"] != "request_limit":
            warnings.append(
                "The alternative-route search stopped early; available results are shown."
            )
    if any(not r["complete"] for r in routes):
        warnings.append(
            "Some routes have incomplete forecasts and are excluded from a complete recommendation."
        )
    result = {
        "id": analysis_id,
        "mode": mode,
        **({"scenario": scenario} if mode == "demo" else {}),
        "policy_version": POLICY_VERSION,
        "created_at": datetime.now(UTC).isoformat(),
        "forecast_retrieved_at": min(
            (f.retrieved_at for f in series if f and f.retrieved_at), default=None
        ),
        "departure_utc": departure.isoformat(),
        "timezone": payload["timezone"],
        "load_weight_lb": payload["load_weight_lb"],
        "interval_miles": payload["interval_miles"],
        "origin": demo.ORIGIN if mode == "demo" else payload["origin"],
        "destination": demo.DESTINATION if mode == "demo" else payload["destination"],
        "recommended_route_id": recommended,
        "explanation": explanation,
        "warnings": warnings,
        "routes": [
            {k: v for k, v in r.items() if k not in ("_rank", "distances", "times")}
            for r in routes
        ],
        "routing_search": route_search,
        "vehicle_profile": {
            "id": "us-semi-v1",
            "tare_lb": 35000,
            "height_m": 4.11,
            "width_m": 2.6,
            "length_m": 21.64,
            "note": "Assessment profile. Payload is added to assumed vehicle tare for live routing. ETAs exclude driver breaks.",
        },
        "data_note": (
            "Demonstration: recorded driving geometry with synthetic weather. Not live truck navigation."
            if mode == "demo"
            else "TomTom truck routes and Open-Meteo forecasts. Sampled exposure is an estimate, not a guarantee of safe travel."
        ),
    }
    cache.set("analysis:" + analysis_id, result, 1800)
    return result


def get_analysis(analysis_id):
    result = cache.get("analysis:" + analysis_id)
    if result is None:
        raise providers.ServiceError(
            "ANALYSIS_EXPIRED",
            "This analysis has expired. Plan the trip again to request new forecasts.",
            410,
        )
    return result


def corridor(analysis, route_id):
    route = next((r for r in analysis["routes"] if r["id"] == route_id), None)
    if not route:
        raise providers.ServiceError(
            "ROUTE_NOT_FOUND", "Select a route from this analysis.", 404
        )
    key = providers.fingerprint("corridor", [analysis["id"], route_id])
    if (saved := cache.get(key)) is not None:
        return saved
    cells, resolution = corridor_cells(route["coordinates"])
    departure = datetime.fromisoformat(analysis["departure_utc"])
    times = [departure + timedelta(hours=i) for i in range(49)]
    forecasts, warnings = (
        ([], [])
        if analysis["mode"] == "demo"
        else providers.fetch_weather(
            [c["coordinates"] for c in cells], times[0], times[-1]
        )
    )
    output = []
    for index, cell in enumerate(cells):
        frames = []
        for moment in times:
            if analysis["mode"] == "demo":
                weather = demo.weather(
                    cell["coordinates"], moment, departure, analysis["scenario"]
                )
            else:
                weather = (
                    forecasts[index].sample(moment)
                    if forecasts[index]
                    else {"wind_mph": None, "rain_in_hr": None, "snow_in_hr": None}
                )
            risk = assess(weather, analysis["load_weight_lb"])
            frames.append(
                [
                    weather["wind_mph"],
                    weather["rain_in_hr"],
                    weather["snow_in_hr"],
                    risk["level"],
                ]
            )
        output.append(
            {
                "id": index,
                "geometry": cell["geometry"],
                "coordinates": cell["coordinates"],
                "frames": frames,
            }
        )
    result = {
        "analysis_id": analysis["id"],
        "route_id": route_id,
        "times": [t.isoformat() for t in times],
        "resolution_miles": resolution,
        "half_width_miles": 20,
        "fields": ["wind_mph", "rain_in_hr", "snow_in_hr", "risk"],
        "cells": output,
        "warnings": warnings,
    }
    cache.set(key, result, 900)
    return result
