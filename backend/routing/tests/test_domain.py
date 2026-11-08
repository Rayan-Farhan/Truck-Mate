from copy import deepcopy
from django.test import SimpleTestCase
from routing.domain import assess, exposure_bounds, summarize, recommend


def weather(wind=5, rain=0, snow=0, gust=10):
    return {"wind_mph": wind, "rain_in_hr": rain, "snow_in_hr": snow, "gust_mph": gust}


def route(identity="a", levels=("low", "low"), positions=(0, 1000), duration=100):
    samples = [
        {"distance_m": d, "level": level, "complete": level != "unknown"}
        for d, level in zip(positions, levels)
    ]
    return {
        "id": identity,
        "label": identity,
        **summarize(samples, positions[-1], duration),
    }


class RiskTests(SimpleTestCase):
    def test_wind_boundaries_and_fractional_values(self):
        for wind, level in [
            (0, "low"),
            (24.999, "low"),
            (25, "moderate"),
            (34.999, "moderate"),
            (35, "high"),
            (44.999, "high"),
            (45, "severe"),
            (54.999, "severe"),
            (55, "no_travel"),
        ]:
            with self.subTest(wind=wind):
                self.assertEqual(assess(weather(wind), 0)["level"], level)

    def test_precipitation_boundaries_are_strict_only_at_no_travel(self):
        for field, cases in [
            (
                "rain",
                [
                    (0.099, "low"),
                    (0.1, "moderate"),
                    (0.249, "moderate"),
                    (0.25, "high"),
                    (0.499, "high"),
                    (0.5, "severe"),
                    (1, "severe"),
                    (1.001, "no_travel"),
                ],
            ),
            (
                "snow",
                [
                    (0.499, "low"),
                    (0.5, "moderate"),
                    (0.999, "moderate"),
                    (1, "high"),
                    (1.999, "high"),
                    (2, "severe"),
                    (3, "severe"),
                    (3.001, "no_travel"),
                ],
            ),
        ]:
            for value, level in cases:
                with self.subTest(field=field, value=value):
                    self.assertEqual(
                        assess(weather(**{field: value}), 0)["level"], level
                    )

    def test_strict_load_thresholds(self):
        for wind, load, expected in [
            (45, 30000, "severe"),
            (45, 30000.01, "no_travel"),
            (35, 40000, "high"),
            (35, 40000.01, "severe"),
            (44.999, 40001, "severe"),
            (55, 0, "no_travel"),
            (55, 28000, "no_travel"),
            (55, 70990, "no_travel"),
        ]:
            with self.subTest(wind=wind, load=load):
                self.assertEqual(assess(weather(wind), load)["level"], expected)

    def test_gusts_do_not_replace_sustained_wind(self):
        self.assertEqual(assess(weather(15, gust=70), 45000)["level"], "low")

    def test_worst_hazard_wins_and_ties_retain_both_reasons(self):
        risk = assess(weather(45, rain=0.7), 0)
        self.assertEqual(risk["level"], "severe")
        self.assertEqual(set(risk["reasons"]), {"wind", "rain"})

    def test_unknown_is_not_calm(self):
        result = assess(weather(None), 0)
        self.assertEqual(result["level"], "unknown")
        self.assertFalse(result["complete"])

    def test_known_no_travel_wins_over_unknown(self):
        result = assess(weather(60, rain=None), 0)
        self.assertEqual(result["level"], "no_travel")
        self.assertFalse(result["complete"])

    def test_negative_or_nonfinite_data_is_unknown(self):
        for value in [-1, float("nan"), float("inf")]:
            self.assertEqual(assess(weather(value), 0)["level"], "unknown")


class ExposureTests(SimpleTestCase):
    def test_average_is_distance_weighted_not_a_checkpoint_count_average(self):
        result = route("weighted", ("high", "low", "low"), (0, 1000, 100000))
        self.assertAlmostEqual(result["average_risk"], 0.01)
        self.assertAlmostEqual(result["miles_by_level"]["high"] * 1609.344, 500)

    def test_midpoint_attribution_including_short_final_segment(self):
        bounds = exposure_bounds([0, 25, 50, 60], 60)
        self.assertEqual([b - a for a, b in bounds], [12.5, 25, 17.5, 5])

    def test_distance_conservation_with_unknown(self):
        r = route(levels=("severe", "unknown", "high"), positions=(0, 333.333, 1000))
        self.assertAlmostEqual(sum(r["miles_by_level"].values()) * 1609.344, 1000)
        self.assertEqual(r["status"], "incomplete")
        self.assertIsNone(r["average_risk"])

    def test_invalid_checkpoint_order_rejected(self):
        with self.assertRaises(ValueError):
            exposure_bounds([0, 50, 50, 60], 60)


class RecommendationTests(SimpleTestCase):
    def test_slow_route_with_fewer_severe_miles_wins(self):
        severe = route("fast", ("severe", "severe"), duration=10)
        clear = route("slow", duration=1000)
        identity, reason = recommend([severe, clear])
        self.assertEqual(identity, "slow")
        self.assertEqual(reason["criterion"], "severe_miles")

    def test_high_miles_then_average_then_time(self):
        for levels_a, levels_b, expected in [
            (("high", "low"), ("moderate", "moderate"), "high_miles"),
            (("moderate", "moderate"), ("low", "low"), "average_risk"),
            (("low", "low"), ("low", "low"), "travel_time"),
        ]:
            with self.subTest(expected=expected):
                a = route("a", levels_a, duration=300)
                b = route("b", levels_b, duration=200)
                identity, reason = recommend([a, b])
                self.assertEqual(identity, "b")
                self.assertEqual(reason["criterion"], expected)

    def test_no_travel_is_a_gate_not_a_weight(self):
        blocked = route("blocked", ("no_travel", "low"), duration=1)
        severe = route("severe", ("severe", "severe"), duration=10000)
        self.assertEqual(recommend([blocked, severe])[0], "severe")

    def test_all_blocked_has_no_recommendation(self):
        self.assertIsNone(
            recommend(
                [
                    route("a", ("no_travel", "low")),
                    route("b", ("no_travel", "no_travel")),
                ]
            )[0]
        )

    def test_incomplete_is_ineligible(self):
        self.assertEqual(
            recommend([route("a", ("unknown", "low")), route("b")])[0], "b"
        )

    def test_exact_ties_are_stable_across_provider_order(self):
        a, b = route("a"), route("b")
        self.assertEqual(recommend([b, a])[0], "a")

    def test_display_rounding_does_not_decide_ranking(self):
        a = route("a", ("severe", "low"), positions=(0, 1000.02))
        b = route("b", ("severe", "low"), positions=(0, 1000))
        self.assertEqual(recommend([a, b])[0], "b")
