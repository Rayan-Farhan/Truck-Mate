from django.test import SimpleTestCase
from routing.geometry import (
    cumulative,
    checkpoints,
    slice_line,
    corridor_cells,
    distinct,
    corridor_waypoints,
    retraces_road,
)
from routing.domain import MILE_METERS


def geometry(length=60 * MILE_METERS):
    return {
        "coordinates": [[-100, 40], [-99.5, 40], [-99, 40]],
        "distances": [0, length / 2, length],
        "times": [0, 1000, 5000],
        "distance_m": length,
        "duration_s": 5000,
    }


class GeometryTests(SimpleTestCase):
    def test_all_intervals_include_both_endpoints(self):
        for interval in (10, 25, 50):
            r = geometry()
            samples = checkpoints(r, interval)
            self.assertEqual(samples[0]["distance_m"], 0)
            self.assertEqual(samples[-1]["distance_m"], r["distance_m"])
            self.assertEqual(len({p["distance_m"] for p in samples}), len(samples))
            self.assertTrue(
                all(
                    abs(p["distance_m"] / MILE_METERS - interval * i) < 1e-8
                    for i, p in enumerate(samples[:-1])
                )
            )

    def test_short_trip_has_two_endpoints(self):
        self.assertEqual(len(checkpoints(geometry(100), 50)), 2)

    def test_arrival_uses_local_speed_profile(self):
        sample = checkpoints(geometry(100000), 25)[1]
        self.assertAlmostEqual(sample["elapsed_s"], 804.672)
        self.assertNotAlmostEqual(
            sample["elapsed_s"], 5000 * sample["distance_m"] / 100000
        )

    def test_slice_interpolates_shared_boundaries(self):
        r = geometry()
        first = slice_line(r["coordinates"], r["distances"], 0, 30000)
        second = slice_line(r["coordinates"], r["distances"], 30000, r["distance_m"])
        self.assertEqual(first[-1], second[0])
        self.assertGreater(len(first), 1)

    def test_geodesic_distance_is_nonnegative(self):
        ds = cumulative([[-100, 40], [-100, 40], [-99, 40]])
        self.assertEqual(ds[:2], [0, 0])
        self.assertGreater(ds[-1], 80000)

    def test_duplicate_detection_is_vertex_density_independent(self):
        a = geometry()
        b = geometry()
        b["coordinates"] = [a["coordinates"][0], a["coordinates"][-1]]
        b["distances"] = [0, a["distance_m"]]
        self.assertFalse(distinct(b, [a]))

    def test_corridor_has_area_and_a_bounded_point_count(self):
        cells, resolution = corridor_cells(
            [[-105, 40], [-95, 41], [-87, 42]], max_cells=60
        )
        self.assertGreater(len(cells), 10)
        self.assertLessEqual(len(cells), 60)
        self.assertGreaterEqual(resolution, 15)
        self.assertTrue(
            all(c["geometry"]["type"] in ("Polygon", "MultiPolygon") for c in cells)
        )

    def test_waypoint_search_has_four_bounded_through_areas(self):
        areas = list(corridor_waypoints(geometry()))
        self.assertEqual(len(areas), 4)
        self.assertEqual(len(set(areas)), 4)
        self.assertTrue(all(area.startswith("circle(") for area in areas))

    def test_out_and_back_is_rejected_but_direct_path_is_not(self):
        self.assertFalse(retraces_road(geometry()))
        self.assertTrue(
            retraces_road(
                {
                    "coordinates": [
                        [-100, 40],
                        [-99.5, 40],
                        [-99.5, 40.2],
                        [-99.5, 40],
                        [-99, 40],
                    ],
                }
            )
        )
