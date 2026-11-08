"""Assessment policy. Pure calculations: no framework, network, or model calls."""

from decimal import Decimal
from enum import IntEnum
from fractions import Fraction
from math import isfinite

POLICY_VERSION = "spotter-1.0"
MILE_METERS = 1609.344


class Risk(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4


LABELS = ["low", "moderate", "high", "severe", "no_travel"]


def finite(value):
    return (
        value is not None
        and isinstance(value, (int, float, Decimal))
        and isfinite(value)
        and value >= 0
    )


def band(value, limits, strict_last=False):
    if not finite(value):
        return None
    value = Decimal(str(value))
    for index in range(3, -1, -1):
        threshold = Decimal(str(limits[index]))
        matches = (
            value > threshold if strict_last and index == 3 else value >= threshold
        )
        if matches:
            return Risk(index + 1)
    return Risk.LOW


def assess(weather, load_lb):
    levels = {
        "wind": band(weather.get("wind_mph"), [25, 35, 45, 55]),
        "rain": band(weather.get("rain_in_hr"), [0.1, 0.25, 0.5, 1], True),
        "snow": band(weather.get("snow_in_hr"), [0.5, 1, 2, 3], True),
    }
    wind = weather.get("wind_mph")
    load = Risk.LOW
    if finite(wind):
        if wind >= 55 or (45 <= wind < 55 and load_lb > 30_000):
            load = Risk.NO_TRAVEL
        elif 35 <= wind < 45 and load_lb > 40_000:
            load = Risk.SEVERE
    levels["load"] = load
    known = [level for level in levels.values() if level is not None]
    worst = max(known, default=Risk.LOW)
    complete = all(level is not None for level in levels.values())
    # Known No Travel establishes blocking even if another hazard is missing.
    overall = worst if complete or worst == Risk.NO_TRAVEL else None
    reasons = [name for name, level in levels.items() if level == worst and worst > 0]
    return {
        "level": LABELS[overall] if overall is not None else "unknown",
        "levels": {
            name: LABELS[level] if level is not None else "unknown"
            for name, level in levels.items()
        },
        "reasons": reasons,
        "complete": complete,
    }


def exposure_bounds(positions, total):
    """Contiguous Voronoi cells on a one-dimensional route, in provider meters."""
    if (
        not positions
        or total <= 0
        or positions[0] != 0
        or abs(positions[-1] - total) > 0.001
    ):
        raise ValueError("Checkpoint positions must cover a positive route.")
    if any(b <= a for a, b in zip(positions, positions[1:])):
        raise ValueError("Checkpoint positions must increase.")
    edges = [0.0, *[(a + b) / 2 for a, b in zip(positions, positions[1:])], total]
    return list(zip(edges, edges[1:]))


def summarize(checkpoints, distance_m, duration_s):
    # Millimeter precision prevents display rounding from deciding the route.
    buckets_mm = dict.fromkeys([*LABELS, "unknown"], 0)
    bounds = exposure_bounds([c["distance_m"] for c in checkpoints], distance_m)
    for cp, (start, end) in zip(checkpoints, bounds):
        length_mm = round(end * 1000) - round(start * 1000)
        buckets_mm[cp["level"]] += length_mm
        cp["exposure_start_m"], cp["exposure_end_m"] = start, end
    total_mm = sum(buckets_mm.values())
    weighted = sum(buckets_mm[label] * i for i, label in enumerate(LABELS))
    incomplete = any(not cp["complete"] for cp in checkpoints)
    blocked = any(cp["level"] == "no_travel" for cp in checkpoints)
    status = "blocked" if blocked else "incomplete" if incomplete else "evaluated"
    return {
        "distance_m": distance_m,
        "duration_s": duration_s,
        "miles_by_level": {k: v / 1000 / MILE_METERS for k, v in buckets_mm.items()},
        "average_risk": None if incomplete else weighted / total_mm,
        "status": status,
        "complete": not incomplete,
        "worst_level": next((k for k in reversed(LABELS) if buckets_mm[k]), "unknown"),
        "_rank": (
            buckets_mm["severe"],
            buckets_mm["high"],
            Fraction(weighted, total_mm),
            round(duration_s * 1000),
        ),
    }


def recommend(routes):
    eligible = sorted(
        (r for r in routes if r["status"] == "evaluated"),
        key=lambda r: (*r["_rank"], r["id"]),
    )
    if not eligible:
        blocked = all(r["status"] == "blocked" for r in routes)
        return None, {
            "criterion": "no_eligible_route",
            "text": (
                "No route recommended. Every alternative contains No Travel conditions."
                if blocked
                else "No complete recommendation is available. Resolve missing forecasts or No Travel conditions before planning travel."
            ),
        }
    best = eligible[0]
    # Explain the trade-off against the fastest competing eligible path, which is
    # usually the useful driver question. Selection still uses the complete key.
    other = (
        min(eligible[1:], key=lambda r: r["duration_s"]) if len(eligible) > 1 else None
    )
    if other:
        for index, criterion in enumerate(
            ["severe_miles", "high_miles", "average_risk", "travel_time"]
        ):
            if best["_rank"][index] != other["_rank"][index]:
                descriptions = {
                    "severe_miles": f"{best['label']} has fewer Severe miles than {other['label']}",
                    "high_miles": f"{best['label']} has fewer High miles than {other['label']}, with equal Severe exposure",
                    "average_risk": f"{best['label']} has the lowest distance-weighted risk after tying on Severe and High miles",
                    "travel_time": f"{best['label']} is quicker, with equal weather-risk metrics",
                }
                return best["id"], {
                    "criterion": criterion,
                    "compared_route_id": other["id"],
                    "text": descriptions[criterion] + ".",
                    "difference": float(other["_rank"][index] - best["_rank"][index])
                    / (1000 * MILE_METERS if index < 2 else 1000 if index == 3 else 1),
                }
        return best["id"], {
            "criterion": "tie",
            "text": "Weather-risk metrics and travel time tie. Route identity provides a stable selection.",
        }
    return best["id"], {
        "criterion": "only_eligible",
        "text": f"{best['label']} is the only fully evaluated alternative without No Travel conditions.",
    }
