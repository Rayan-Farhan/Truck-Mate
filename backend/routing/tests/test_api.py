from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from routing.api import AnalysisSerializer
from routing.briefings import validate, briefing, facts_for
from routing.services import analyze

BASE = {
    "mode": "demo",
    "scenario": "storm",
    "departure_local": "2026-11-09T08:00",
    "timezone": "America/Chicago",
    "load_weight_lb": 28000,
    "interval_miles": 25,
}


@override_settings(TEST_FIXTURES_ENABLED=True)
class ApiTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def post(self, **changes):
        return self.client.post(
            "/api/analyses", {**BASE, **changes}, content_type="application/json"
        )

    def test_demo_is_complete_and_labeled_without_keys(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        a = response.json()
        self.assertEqual(len(a["routes"]), 3)
        self.assertEqual(a["mode"], "demo")
        self.assertIn("synthetic", a["data_note"])
        self.assertIsNotNone(a["recommended_route_id"])
        fastest = min(a["routes"], key=lambda r: r["duration_s"])
        self.assertNotEqual(a["recommended_route_id"], fastest["id"])
        self.assertEqual(a["explanation"]["criterion"], "severe_miles")
        for route in a["routes"]:
            self.assertAlmostEqual(
                sum(route["miles_by_level"].values()) * 1609.344,
                route["distance_m"],
                delta=0.002,
            )
            self.assertEqual(
                len(route["segments"]["features"]), len(route["checkpoints"])
            )

    def test_all_blocked_returns_null_recommendation(self):
        a = self.post(scenario="all_blocked").json()
        self.assertIsNone(a["recommended_route_id"])
        self.assertTrue(all(r["status"] == "blocked" for r in a["routes"]))

    def test_identical_requests_reuse_server_analysis(self):
        first = self.post().json()
        second = self.post().json()
        self.assertEqual(first["id"], second["id"])

    def test_missing_forecasts_do_not_create_a_recommendation(self):
        a = self.post(scenario="missing_data").json()
        self.assertIsNone(a["recommended_route_id"])
        self.assertTrue(all(r["miles_by_level"]["unknown"] > 0 for r in a["routes"]))

    def test_clear_weather_chooses_fastest(self):
        a = self.post(scenario="clear").json()
        self.assertEqual(
            a["recommended_route_id"],
            min(a["routes"], key=lambda r: r["duration_s"])["id"],
        )

    def test_load_scenario_changes_at_strict_boundary(self):
        self.assertIsNotNone(
            self.post(scenario="load_boundary", load_weight_lb=30000).json()[
                "recommended_route_id"
            ]
        )
        self.assertIsNone(
            self.post(scenario="load_boundary", load_weight_lb=30001).json()[
                "recommended_route_id"
            ]
        )

    def test_invalid_inputs_and_intervals(self):
        for fields in [
            {"load_weight_lb": -1},
            {"load_weight_lb": 80001},
            {"interval_miles": 30},
            {"departure_local": "invalid"},
            {"timezone": "invalid/zone"},
        ]:
            with self.subTest(fields=fields):
                self.assertEqual(self.post(**fields).status_code, 400)

    @patch("routing.api.services.analyze")
    def test_extended_live_validation_rejects_invalid_requests_before_providers(
        self, analyze
    ):
        now = datetime.now(timezone.utc)
        local = lambda moment: moment.replace(tzinfo=None).isoformat(timespec="minutes")
        live = {
            "mode": "live",
            "departure_local": local(now + timedelta(hours=1)),
            "timezone": "UTC",
            "origin": {"label": "A", "lat": 40, "lon": -100},
            "destination": {"label": "B", "lat": 41, "lon": -99},
        }
        for changes in [
            {"departure_local": local(now - timedelta(hours=1))},
            {"departure_local": local(now + timedelta(days=15))},
            {"destination": live["origin"]},
            {"origin": {"label": "A", "lat": "nan", "lon": -100}},
            {"destination": {"label": "B", "lat": 41, "lon": "nan"}},
            {"origin": {"label": "A", "lat": 51, "lon": -100}},
            {"load_weight_lb": "nan"},
            {"load_weight_lb": "inf"},
        ]:
            with self.subTest(changes=changes):
                self.assertEqual(self.post(**{**live, **changes}).status_code, 400)
        analyze.assert_not_called()

    def test_valid_payload_endpoints_and_timezone_conversion(self):
        for weight in (0, 80000):
            with self.subTest(weight=weight):
                self.assertEqual(
                    self.post(scenario="clear", load_weight_lb=weight).status_code, 200
                )
        chicago = AnalysisSerializer(
            data={
                **BASE,
                "departure_local": "2026-11-09T08:00",
                "timezone": "America/Chicago",
            }
        )
        utc = AnalysisSerializer(
            data={**BASE, "departure_local": "2026-11-09T14:00", "timezone": "UTC"}
        )
        chicago.is_valid(raise_exception=True)
        utc.is_valid(raise_exception=True)
        self.assertEqual(
            chicago.validated_data["departure_utc"], utc.validated_data["departure_utc"]
        )

    def test_config_never_returns_credentials(self):
        response = self.client.get("/api/config")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), {"live_routing", "bedrock", "groq"})

    @override_settings(TEST_FIXTURES_ENABLED=False)
    @patch("routing.api.services.analyze")
    def test_public_api_rejects_synthetic_mode(self, analyze):
        self.assertEqual(self.post().status_code, 400)
        analyze.assert_not_called()

    def test_nonexistent_and_ambiguous_local_times(self):
        self.assertEqual(self.post(departure_local="2026-03-08T02:30").status_code, 400)
        repeated = self.post(departure_local="2026-11-01T01:30")
        self.assertEqual(repeated.status_code, 400)
        self.assertIn("utc_offset_minutes", repeated.json()["error"]["fields"])
        self.assertEqual(
            self.post(
                departure_local="2026-11-01T01:30", utc_offset_minutes=-300
            ).status_code,
            200,
        )

    @override_settings(TOMTOM_API_KEY="")
    def test_live_does_not_fall_back_to_demo(self):
        local = (
            (datetime.now(timezone.utc) + timedelta(hours=2))
            .replace(tzinfo=None)
            .isoformat(timespec="minutes")
        )
        r = self.post(
            mode="live",
            departure_local=local,
            timezone="UTC",
            origin={"label": "Chicago", "lat": 41.8, "lon": -87.6},
            destination={"label": "Denver", "lat": 39.7, "lon": -104.9},
        )
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"]["code"], "ROUTING_NOT_CONFIGURED")

    @patch("routing.services.providers.fetch_weather")
    @patch("routing.services.providers.routes")
    def test_partial_live_search_exposes_limits_without_claiming_no_more_routes(
        self, route_search, weather
    ):
        from routing import demo
        from routing.geometry import checkpoints
        from routing.providers import RouteSearch

        fixture_routes = demo.routes()[:2]
        details = {"requests": 5, "stopped_reason": "request_limit"}
        route_search.return_value = RouteSearch(fixture_routes, details)
        weather.return_value = (
            [None for route in fixture_routes for _ in checkpoints(route, 25)],
            [],
        )
        local = (
            (datetime.now(timezone.utc) + timedelta(hours=2))
            .replace(tzinfo=None)
            .isoformat(timespec="minutes")
        )
        response = self.post(
            mode="live",
            departure_local=local,
            timezone="UTC",
            origin={"label": "Chicago", "lat": 41.8, "lon": -87.6},
            destination={"label": "Denver", "lat": 39.7, "lon": -104.9},
        )
        self.assertEqual(response.status_code, 200)
        analysis = response.json()
        self.assertEqual(len(analysis["routes"]), 2)
        self.assertEqual(analysis["routing_search"], details)
        self.assertNotIn("scenario", analysis)
        self.assertTrue(
            any("Other routes may exist" in message for message in analysis["warnings"])
        )

    def test_corridor_has_all_49_frames(self):
        a = self.post().json()
        r = self.client.post(
            f"/api/analyses/{a['id']}/corridor",
            {"route_id": a["routes"][0]["id"]},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        c = r.json()
        self.assertEqual(len(c["times"]), 49)
        self.assertLessEqual(len(c["cells"]), 192)
        self.assertTrue(all(len(cell["frames"]) == 49 for cell in c["cells"]))

    def test_expired_analysis_has_explicit_status(self):
        r = self.client.post(
            "/api/analyses/not-present/corridor",
            {"route_id": "a"},
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 410)


@override_settings(TEST_FIXTURES_ENABLED=True)
class BriefingTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        serializer = AnalysisSerializer(data=BASE)
        serializer.is_valid(raise_exception=True)
        self.analysis = analyze(serializer.validated_data)
        self.facts = facts_for(self.analysis)

    def test_model_cannot_override_route_selection(self):
        with self.assertRaises(ValueError):
            validate(
                '{"route_id":"wrong","summary":"Choose another route instead.","fact_ids":[]}',
                self.facts,
            )

    def test_only_verified_number_placeholders_are_substituted(self):
        import json

        content = json.dumps(
            {
                "route_id": self.analysis["recommended_route_id"],
                "summary": "Consider the calculated alternative. The direct route has {{r0_severe}}.",
                "fact_ids": ["r0_severe"],
            }
        )
        self.assertIn(
            self.facts["fact_catalog"]["r0_severe"], validate(content, self.facts)
        )
        with self.assertRaises(ValueError):
            validate(content.replace("{{r0_severe}}", "999 miles"), self.facts)

    @override_settings(BEDROCK_ENABLED=False, GROQ_API_KEY="")
    def test_no_credentials_returns_calculated_summary(self):
        result = briefing(self.analysis)
        self.assertEqual(result["source"], "calculated")
        self.assertEqual(result["text"], self.analysis["explanation"]["text"])

    @override_settings(
        BEDROCK_ENABLED=True,
        GROQ_API_KEY="test-key",
        GROQ_MODEL="llama-3.3-70b-versatile",
    )
    @patch("routing.briefings.CLIENT.post")
    @patch("routing.briefings.boto3.client", side_effect=RuntimeError("Unavailable"))
    def test_bedrock_failure_uses_groq(self, bedrock, post):
        import json

        post.return_value.json.return_value = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "route_id": self.analysis["recommended_route_id"],
                                "summary": "The calculated route avoids the elevated exposure on the direct corridor. Review the checkpoint forecasts before departure.",
                                "fact_ids": [],
                            }
                        )
                    }
                }
            ]
        }
        self.assertEqual(briefing(self.analysis)["source"], "groq")
        self.assertEqual(
            post.call_args.kwargs["json"]["response_format"], {"type": "json_object"}
        )

    @override_settings(
        BEDROCK_ENABLED=False, GROQ_API_KEY="test-key", GROQ_MODEL="openai/gpt-oss-120b"
    )
    @patch("routing.briefings.CLIENT.post")
    def test_reasoning_model_uses_strict_schema_for_decision_and_fact_references(
        self, post
    ):
        import json

        for identity in [self.analysis["recommended_route_id"], None]:
            with self.subTest(recommended_route=identity):
                cache.clear()
                self.analysis["recommended_route_id"] = identity
                post.return_value.json.return_value = {
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "route_id": identity,
                                        "summary": (
                                            "Review the checkpoint forecasts on the recommended route."
                                            if identity
                                            else "No route is recommended. Review the weather warnings before planning travel."
                                        ),
                                        "fact_ids": [],
                                    }
                                )
                            }
                        }
                    ]
                }
                result = briefing(self.analysis)
                self.assertEqual(result["source"], "groq")
                payload = post.call_args.kwargs["json"]
                schema = payload["response_format"]["json_schema"]
                self.assertTrue(schema["strict"])
                self.assertEqual(
                    schema["schema"]["properties"]["route_id"]["enum"], [identity]
                )
                self.assertEqual(
                    schema["schema"]["properties"]["fact_ids"]["items"]["enum"],
                    list(self.facts["fact_catalog"]),
                )
                self.assertEqual(payload["reasoning_effort"], "low")
                self.assertEqual(payload["max_completion_tokens"], 1024)
                self.assertNotIn("max_tokens", payload)

    @override_settings(BEDROCK_ENABLED=True, GROQ_API_KEY="test-key")
    @patch("routing.briefings.CLIENT.post", side_effect=RuntimeError("Unavailable"))
    @patch("routing.briefings.boto3.client", side_effect=RuntimeError("Unavailable"))
    def test_both_providers_failing_does_not_change_recommendation(self, bedrock, post):
        before = self.analysis["recommended_route_id"]
        self.assertEqual(briefing(self.analysis)["source"], "calculated")
        self.assertEqual(self.analysis["recommended_route_id"], before)
