"""Provider-distance-aligned WGS84 geometry and exact exposure slicing."""

from bisect import bisect_right
from hashlib import sha256
import json
from math import ceil

from pyproj import Geod, CRS, Transformer
from shapely.geometry import LineString, box, mapping
from shapely.ops import transform, unary_union

from .domain import MILE_METERS

GEOD = Geod(ellps="WGS84")


def cumulative(coords):
    result = [0.0]
    for a, b in zip(coords, coords[1:]):
        result.append(result[-1] + GEOD.inv(*a, *b)[2])
    return result


def interpolate(a, b, fraction):
    bearing, _, distance = GEOD.inv(*a, *b)
    lon, lat, _ = GEOD.fwd(*a, bearing, distance * fraction)
    return [lon, lat]


def at_distance(coords, distances, target):
    if target <= 0:
        return coords[0], 0, 0.0
    if target >= distances[-1]:
        return coords[-1], len(coords) - 2, 1.0
    i = min(len(coords) - 2, bisect_right(distances, target) - 1)
    span = distances[i + 1] - distances[i]
    fraction = (target - distances[i]) / span if span else 0
    return interpolate(coords[i], coords[i + 1], fraction), i, fraction


def checkpoints(route, interval_miles):
    if interval_miles not in (10, 25, 50):
        raise ValueError("Choose 10, 25, or 50 miles.")
    total = route["distance_m"]
    step = interval_miles * MILE_METERS
    targets = [i * step for i in range(ceil(total / step))]
    if total - targets[-1] > 0.001:
        targets.append(total)
    else:
        targets[-1] = total
    result = []
    for i, target in enumerate(targets):
        point, index, fraction = at_distance(
            route["coordinates"], route["distances"], target
        )
        times = route["times"]
        elapsed = times[index] + (times[index + 1] - times[index]) * fraction
        result.append(
            {
                "sequence": i,
                "distance_m": target,
                "coordinates": point,
                "elapsed_s": elapsed,
            }
        )
    return result


def slice_line(coords, distances, start, end):
    a, _, _ = at_distance(coords, distances, start)
    b, _, _ = at_distance(coords, distances, end)
    return [a, *[p for p, d in zip(coords, distances) if start < d < end], b]


def segments(route, samples):
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": slice_line(
                        route["coordinates"],
                        route["distances"],
                        cp["exposure_start_m"],
                        cp["exposure_end_m"],
                    ),
                },
                "properties": {
                    "level": cp["level"],
                    "route_id": route["id"],
                    "sequence": cp["sequence"],
                },
            }
            for cp in samples
        ],
    }


def route_identity(coords):
    return sha256(json.dumps(coords, separators=(",", ":")).encode()).hexdigest()[:20]


def distinct(candidate, kept):
    """Distance-weighted path proximity, independent of vertex sampling density."""
    if not kept:
        return True
    # A candidate must have meaningful distinct road distance; resampling avoids vertex-count bias.
    coords = candidate["coordinates"]
    center = coords[len(coords) // 2]
    local = CRS.from_proj4(
        f"+proj=aeqd +lat_0={center[1]} +lon_0={center[0]} +datum=WGS84 +units=m"
    )
    forward = Transformer.from_crs(4326, local, always_xy=True).transform
    points = [
        at_distance(coords, candidate["distances"], candidate["distance_m"] * i / 100)[
            0
        ]
        for i in range(101)
    ]
    for previous in kept:
        corridor = transform(forward, LineString(previous["coordinates"])).buffer(150)
        from shapely.geometry import Point

        overlap = sum(
            corridor.covers(transform(forward, Point(point))) for point in points
        ) / len(points)
        if overlap > 0.98:
            return False
    return True


def corridor_waypoints(route):
    """Broad through-areas on either side of the road, not arbitrary stop addresses."""
    offset = min(64000, max(5000, route["distance_m"] * 0.12))
    radius = round(offset * 0.3)
    for fraction in (0.45, 0.65):
        point, index, _ = at_distance(
            route["coordinates"], route["distances"], route["distance_m"] * fraction
        )
        bearing, _, _ = GEOD.inv(
            *route["coordinates"][index], *route["coordinates"][index + 1]
        )
        for side in (-90, 90):
            lon, lat, _ = GEOD.fwd(*point, bearing + side, offset)
            if 24 <= lat <= 50 and -125 <= lon <= -66:
                yield f"circle({lat:.6f},{lon:.6f},{radius})"


def retraces_road(route):
    """Reject substantial exact retracing instead of padding options with out-and-backs."""
    coords = route["coordinates"]
    center = coords[len(coords) // 2]
    local = CRS.from_proj4(
        f"+proj=aeqd +lat_0={center[1]} +lon_0={center[0]} +datum=WGS84 +units=m"
    )
    forward = Transformer.from_crs(4326, local, always_xy=True).transform
    line = transform(forward, LineString(coords))
    return line.length > 0 and unary_union(line).length < line.length * 0.95


def corridor_cells(coords, max_cells=192, half_width_miles=20):
    center = coords[len(coords) // 2]
    local = CRS.from_proj4(
        f"+proj=aeqd +lat_0={center[1]} +lon_0={center[0]} +datum=WGS84 +units=m"
    )
    forward = Transformer.from_crs(4326, local, always_xy=True).transform
    inverse = Transformer.from_crs(local, 4326, always_xy=True).transform
    area = transform(forward, LineString(coords)).buffer(
        half_width_miles * MILE_METERS, quad_segs=4
    )
    spacing = 15 * MILE_METERS
    while True:
        west, south, east, north = area.bounds
        nx, ny = ceil((east - west) / spacing), ceil((north - south) / spacing)
        # Bounding-grid iteration is itself bounded before expensive clipping.
        if nx * ny > 6000:
            spacing *= 1.3
            continue
        cells = []
        for x in range(nx):
            for y in range(ny):
                tile = box(
                    west + x * spacing,
                    south + y * spacing,
                    west + (x + 1) * spacing,
                    south + (y + 1) * spacing,
                )
                clipped = tile.intersection(area)
                if not clipped.is_empty and clipped.area > 10_000:
                    sample = clipped.representative_point()
                    cells.append(
                        {
                            "coordinates": list(inverse(sample.x, sample.y)),
                            "geometry": mapping(transform(inverse, clipped)),
                        }
                    )
        if len(cells) <= max_cells:
            return cells, spacing / MILE_METERS
        spacing *= 1.2
