"""Explicit, deterministic demonstration data. Never presented as live weather."""

from copy import deepcopy
import json
from math import exp, sin
from pathlib import Path

from .geometry import route_identity

ORIGIN = {"label": "Chicago, IL", "lat": 41.8781, "lon": -87.6298}
DESTINATION = {"label": "Denver, CO", "lat": 39.7392, "lon": -104.9903}
SCENARIOS = [
    {
        "id": "storm",
        "label": "A safer way around",
        "description": "A synthetic Plains storm makes the direct route less favorable.",
    },
    {
        "id": "all_blocked",
        "label": "No Travel on every route",
        "description": "Widespread 58 mph wind proves that no route gets recommended.",
    },
    {
        "id": "missing_data",
        "label": "A gap in the forecast",
        "description": "Missing western forecasts remain Unknown, never calm.",
    },
    {
        "id": "clear",
        "label": "Clear roads, quicker trip",
        "description": "Equal Low risk lets estimated travel time decide.",
    },
    {
        "id": "load_boundary",
        "label": "The weight of the decision",
        "description": "45 mph wind: exactly 30,000 lb is Severe; above it is No Travel.",
    },
]


def routes():
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "demo_routes.json").read_text(
            encoding="utf-8-sig"
        )
    )
    labels = [
        ("Direct corridor", "I-80 · I-76"),
        ("Northern corridor", "Via Sioux Falls"),
        ("Southern corridor", "Via Kansas City"),
    ]
    result = deepcopy(fixture["routes"])
    for route, (label, road) in zip(result, labels):
        route.update(
            id=route_identity(route["coordinates"]),
            label=label,
            road=road,
            eta_model="recorded_driving_fixture",
        )
    return result


def weather(point, moment, departure, scenario):
    lon, lat = point
    hour = (moment - departure).total_seconds() / 3600
    storm = exp(
        -(((lon + 98.1 - 0.08 * hour) / 2.0) ** 2 + ((lat - 41.25) / 1.45) ** 2)
    )
    northern = exp(-(((lon + 99) / 4) ** 2 + ((lat - 42.8) / 1.4) ** 2))
    wind, rain, snow = (
        12 + 38 * storm + 16 * northern,
        0.015 + 0.48 * storm,
        0.7 * northern,
    )
    if scenario == "clear":
        wind, rain, snow = 9 + 2 * sin(lon), 0.01, 0
    elif scenario == "all_blocked":
        wind, rain, snow = 58, 0.02, 0
    elif scenario == "load_boundary":
        wind, rain, snow = 45, 0.02, 0
    elif scenario == "missing_data" and lon < -99:
        wind = rain = snow = None
    return {
        "wind_mph": wind,
        "gust_mph": wind + 9 if wind is not None else None,
        "rain_in_hr": rain,
        "snow_in_hr": snow,
        "interval_start": moment.replace(minute=0, second=0, microsecond=0).isoformat(),
        "interval_end": None,
        "synthetic": True,
    }
