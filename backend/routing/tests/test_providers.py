from datetime import datetime, timezone
from unittest.mock import patch
import httpx
from django.test import SimpleTestCase, override_settings
from django.core.cache import cache
from routing.providers import (
    Forecast,
    parse_forecast,
    parse_tomtom,
    fetch_weather,
    ServiceError,
    get_json,
    routes,
    places,
)

UTC = timezone.utc
START = datetime(2026, 11, 9, tzinfo=UTC)


def series():
    return Forecast(
        [START.timestamp() + i * 3600 for i in range(3)],
        [0, 10, 20],
        [5, 15, 25],
        [0, 2.54, 25.4],
        [0, 2.54, 0],
        [0, 2.54, 0],
    )


class WeatherTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_instant_wind_and_interval_precipitation(self):
        sample = series().sample(START.replace(minute=30))
        self.assertAlmostEqual(sample["wind_mph"], 5 / 0.44704)
        self.assertAlmostEqual(sample["rain_in_hr"], 0.2)
        self.assertAlmostEqual(sample["snow_in_hr"], 1)
        self.assertEqual(sample["interval_end"], "2026-11-09T01:00:00+00:00")

    def test_exact_boundary_uses_interval_ending_at_that_hour(self):
        sample = series().sample(START.replace(hour=1))
        self.assertAlmostEqual(sample["rain_in_hr"], 0.2)
        self.assertAlmostEqual(sample["wind_mph"], 10 / 0.44704)

    def test_no_clamping_before_or_after_forecast(self):
        for instant in [START.replace(year=2025), START.replace(hour=3)]:
            self.assertIsNone(series().sample(instant)["wind_mph"])

    def test_null_is_preserved(self):
        s = series()
        s.wind[1] = None
        self.assertIsNone(s.sample(START.replace(minute=30))["wind_mph"])

    def test_gap_is_not_interpolated(self):
        s = series()
        s.times[1] = s.times[0] + 7200
        self.assertIsNone(s.sample(START.replace(minute=30))["rain_in_hr"])

    def test_units_are_checked(self):
        with self.assertRaises(ServiceError):
            parse_forecast({"hourly_units": {"wind_speed_10m": "km/h"}})

    @override_settings(WEATHER_LOCATION_LIMIT_PER_MINUTE=0)
    @patch("routing.providers.get_json")
    def test_budget_exhaustion_does_not_send_or_invent_forecasts(self, get):
        rows, warnings = fetch_weather([[-100, 40]], START, START.replace(hour=2))
        get.assert_not_called()
        self.assertEqual(rows, [None])
        self.assertTrue(any("budget" in message for message in warnings))

    @override_settings(OPEN_METEO_API_KEY="")
    @patch("routing.providers.get_json")
    def test_public_forecast_is_keyless_and_duplicates_are_reused(self, get):
        units = {
            "wind_speed_10m": "m/s",
            "wind_gusts_10m": "m/s",
            "rain": "mm",
            "showers": "mm",
            "snowfall": "cm",
        }
        get.return_value = {
            "hourly_units": units,
            "hourly": {"time": series().times, **{k: [0, 0, 0] for k in units}},
        }
        output, warnings = fetch_weather(
            [[-100, 40], [-100, 40]], START, START.replace(hour=2)
        )
        self.assertFalse(warnings)
        self.assertIs(output[0], output[1])
        self.assertNotIn("apikey", get.call_args.args[1])
        self.assertEqual(get.call_count, 1)

    @patch(
        "routing.providers.get_json",
        side_effect=ServiceError("WEATHER_UNAVAILABLE", "Unavailable"),
    )
    def test_failure_returns_unknown_not_fake_forecast(self, get):
        rows, warnings = fetch_weather([[-100, 40]], START, START.replace(hour=2))
        self.assertEqual(rows, [None])
        self.assertTrue(warnings)

    @patch("routing.providers.CLIENT.get")
    def test_errors_never_echo_api_credentials(self, get):
        get.side_effect = httpx.ConnectError("secret-key-in-url")
        with self.assertRaises(ServiceError) as context:
            get_json("https://example.com", {"key": "secret-key-in-url"})
        self.assertNotIn("secret", str(context.exception))


class PlaceTests(SimpleTestCase):
    @override_settings(TOMTOM_API_KEY="test-only")
    @patch("routing.providers.get_json")
    def test_city_and_county_with_same_provider_label_are_distinguishable(self, get):
        cache.clear()
        get.return_value = {
            "results": [
                {
                    "entityType": "Municipality",
                    "address": {"freeformAddress": "Laramie, WY"},
                    "position": {"lat": 41.31, "lon": -105.59},
                },
                {
                    "entityType": "CountrySecondarySubdivision",
                    "address": {
                        "freeformAddress": "Laramie, WY",
                        "countrySecondarySubdivision": "Laramie",
                        "countrySubdivisionCode": "WY",
                    },
                    "position": {"lat": 41.14, "lon": -104.82},
                },
            ]
        }
        result = places("Laramie")
        self.assertEqual(
            [r["label"] for r in result], ["Laramie, WY", "Laramie County, WY"]
        )
        self.assertEqual(result[0]["lon"], -105.59)
        self.assertEqual(result[1]["lon"], -104.82)


class RoutingTests(SimpleTestCase):
    def test_root_progress_is_used_for_nonuniform_travel_time(self):
        item = {
            "summary": {"lengthInMeters": 100000, "travelTimeInSeconds": 5000},
            "legs": [
                {
                    "summary": {"lengthInMeters": 100000, "travelTimeInSeconds": 5000},
                    "points": [
                        {"longitude": -100, "latitude": 40},
                        {"longitude": -99.5, "latitude": 40},
                        {"longitude": -99, "latitude": 40},
                    ],
                }
            ],
            "progress": [
                {"pointIndex": 0, "distanceInMeters": 0, "travelTimeInSeconds": 0},
                {
                    "pointIndex": 1,
                    "distanceInMeters": 50000,
                    "travelTimeInSeconds": 1000,
                },
                {
                    "pointIndex": 2,
                    "distanceInMeters": 100000,
                    "travelTimeInSeconds": 5000,
                },
            ],
        }
        result = parse_tomtom(item)
        self.assertEqual(result["times"], [0, 1000, 5000])
        self.assertEqual(result["eta_model"], "provider_progress")

    def test_invalid_geometry_is_rejected(self):
        with self.assertRaises(ServiceError):
            parse_tomtom({"legs": []})


class ProviderRecoveryTests(SimpleTestCase):
    @patch("routing.providers.CLIENT.get")
    def test_short_connection_failure_is_retried_without_logging_credentials(self, get):
        get.side_effect = [
            httpx.ReadError("secret-key-in-url"),
            httpx.Response(
                200,
                json={"ok": True},
                request=httpx.Request(
                    "GET", "https://api.tomtom.com/search/2/geocode/Chicago.json"
                ),
            ),
        ]
        with self.assertLogs("routing.providers", level="WARNING") as logs:
            result = get_json(
                "https://api.tomtom.com/search/2/geocode/Chicago.json",
                {"key": "secret-key-in-url"},
            )
        self.assertEqual(result, {"ok": True})
        self.assertEqual(get.call_count, 2)
        self.assertIn("TomTom location search", " ".join(logs.output))
        self.assertNotIn("secret-key", " ".join(logs.output))

    @patch("routing.providers.CLIENT.get")
    def test_read_timeout_has_a_specific_provider_message(self, get):
        get.side_effect = httpx.ReadTimeout("secret-key-in-url")
        with self.assertRaises(ServiceError) as context:
            get_json("https://api.tomtom.com/routing/1/calculateRoute/example/json", {})
        self.assertEqual(context.exception.code, "PROVIDER_TIMEOUT")
        self.assertIn("TomTom route planning took too long", context.exception.message)
        self.assertNotIn("secret-key", context.exception.message)
        self.assertEqual(get.call_count, 1)

    @patch("routing.providers.CLIENT.get")
    def test_transient_server_error_is_retried_but_authentication_is_not(self, get):
        request = httpx.Request(
            "GET", "https://api.tomtom.com/search/2/geocode/Chicago.json"
        )
        get.side_effect = [
            httpx.Response(503, request=request),
            httpx.Response(200, json={"ok": True}, request=request),
        ]
        self.assertEqual(get_json(str(request.url), {}), {"ok": True})
        self.assertEqual(get.call_count, 2)
        get.reset_mock(side_effect=True)
        get.return_value = httpx.Response(401, request=request)
        with self.assertRaises(ServiceError) as context:
            get_json(str(request.url), {})
        self.assertEqual(context.exception.code, "PROVIDER_AUTH")
        self.assertEqual(get.call_count, 1)


def provider_route(offset=0, distance=100000, duration=3600):
    return {
        "legs": [
            {
                "summary": {
                    "lengthInMeters": distance,
                    "travelTimeInSeconds": duration,
                },
                "points": [
                    {"longitude": -100, "latitude": 40},
                    {"longitude": -99.5, "latitude": 40 + offset},
                    {"longitude": -99, "latitude": 40},
                ],
            }
        ],
    }


@override_settings(TOMTOM_API_KEY="test-only")
class AlternativeSearchTests(SimpleTestCase):
    origin = {"lat": 40, "lon": -100}
    destination = {"lat": 40, "lon": -99}

    def setUp(self):
        cache.clear()

    def search(self):
        return routes(self.origin, self.destination, START, 28000)

    @patch("routing.providers.get_json")
    def test_broader_initial_search_needs_no_fallback_when_three_are_distinct(
        self, get
    ):
        get.return_value = {"routes": [provider_route(n) for n in (0, 0.2, -0.2, 0.3)]}
        search = self.search()
        self.assertEqual(len(search.routes), 3)
        self.assertEqual(search.details["provider_candidates"], 4)
        self.assertEqual(search.details["stopped_reason"], "target_reached")
        self.assertEqual(get.call_count, 1)
        params = get.call_args.args[1]
        self.assertIn(("maxAlternatives", "5"), params)
        self.assertIn(("alternativeType", "anyRoute"), params)
        self.assertEqual(
            [r["label"] for r in search.routes], ["Route 1", "Route 2", "Route 3"]
        )

    @patch("routing.providers.get_json")
    def test_waypoint_search_finds_third_route_with_same_truck_and_departure(self, get):
        get.side_effect = [
            {"routes": [provider_route(), provider_route(0.2)]},
            {"routes": [provider_route(-0.2, duration=4000)]},
        ]
        search = self.search()
        self.assertEqual(len(search.routes), 3)
        self.assertEqual(search.details["requests"], 2)
        first, fallback = get.call_args_list
        self.assertIn(":circle(", fallback.args[0])
        self.assertEqual(first.args[1], fallback.args[1])
        self.assertIn(("travelMode", "truck"), fallback.args[1])
        self.assertIn(("vehicleWeight", "28576"), fallback.args[1])
        self.assertIn(("departAt", START.isoformat()), fallback.args[1])
        self.assertIn("alternate corridor", search.routes[-1]["road"])
        self.assertLessEqual(fallback.kwargs["timeout"], 5)

    @patch("routing.providers.get_json")
    def test_duplicate_candidates_never_pad_the_result_and_requests_are_bounded(
        self, get
    ):
        get.return_value = {"routes": [provider_route(), provider_route()]}
        search = self.search()
        self.assertEqual(len(search.routes), 1)
        self.assertEqual(get.call_count, 5)
        self.assertGreater(search.details["duplicates_rejected"], 0)
        again = self.search()
        self.assertEqual(again.details, search.details)
        self.assertEqual(get.call_count, 5)

    @patch("routing.providers.get_json")
    def test_extreme_detours_are_not_used_as_a_third_option(self, get):
        get.side_effect = [
            {"routes": [provider_route()]},
            *[{"routes": [provider_route(0.5, distance=200000)]}] * 4,
        ]
        search = self.search()
        self.assertEqual(len(search.routes), 1)
        self.assertEqual(search.details["detours_rejected"], 4)

    @patch("routing.providers.get_json")
    def test_optional_failure_preserves_routes_and_rate_limits_stop_search(self, get):
        get.side_effect = [
            {"routes": [provider_route()]},
            ServiceError("PROVIDER_UNAVAILABLE", "Unavailable"),
            ServiceError("PROVIDER_RATE_LIMIT", "Busy"),
        ]
        search = self.search()
        self.assertEqual(len(search.routes), 1)
        self.assertEqual(get.call_count, 3)
        self.assertEqual(search.details["stopped_reason"], "provider_rate_limit")
        self.assertEqual(search.details["failed_requests"], 2)

    @patch("routing.providers.monotonic", side_effect=[0, 32])
    @patch("routing.providers.get_json")
    def test_expired_time_budget_starts_no_fallback(self, get, clock):
        get.return_value = {"routes": [provider_route()]}
        search = self.search()
        self.assertEqual(get.call_count, 1)
        self.assertEqual(search.details["stopped_reason"], "time_limit")

    @patch("routing.providers.get_json")
    def test_long_distance_routing_uses_lighter_query_with_longer_timeout(self, get):
        get.return_value = {"routes": [provider_route(n) for n in (0, 0.2, -0.2)]}
        search = routes(
            {"lat": 40.693, "lon": -74.272},
            {"lat": 47.446, "lon": -100.469},
            START,
            28000,
        )
        self.assertEqual(len(search.routes), 3)
        self.assertIn(("maxAlternatives", "2"), get.call_args.args[1])
        self.assertEqual(get.call_args.kwargs["timeout"], 30)
        self.assertEqual(search.details["initial_max_alternatives"], 2)
