from datetime import datetime, timedelta, timezone
from math import isfinite
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.conf import settings
from django.http import FileResponse, JsonResponse
from django.views.decorators.cache import never_cache
from rest_framework import serializers
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from . import demo, providers, services, briefings


def exception_handler(exc, context):
    if isinstance(exc, providers.ServiceError):
        return Response(
            {"error": {"code": exc.code, "message": exc.message}}, status=exc.status
        )
    response = drf_exception_handler(exc, context)
    if response is not None:
        response.data = {
            "error": {
                "code": (
                    "VALIDATION_ERROR"
                    if response.status_code == 400
                    else "REQUEST_ERROR"
                ),
                "message": (
                    "Please check the highlighted input."
                    if response.status_code == 400
                    else "This request could not be completed."
                ),
                "fields": response.data,
            }
        }
    return response


class PlaceSerializer(serializers.Serializer):
    label = serializers.CharField(max_length=250)
    lat = serializers.FloatField(min_value=24, max_value=50)
    lon = serializers.FloatField(min_value=-125, max_value=-66)

    def validate(self, attrs):
        invalid = {
            name: "Choose a location with finite coordinates."
            for name in ("lat", "lon")
            if not isfinite(attrs[name])
        }
        if invalid:
            raise serializers.ValidationError(invalid)
        return attrs


class AnalysisSerializer(serializers.Serializer):
    mode = serializers.ChoiceField(choices=["demo", "live"], default="live")
    scenario = serializers.ChoiceField(
        choices=[s["id"] for s in demo.SCENARIOS], default="storm"
    )
    origin = PlaceSerializer(required=False)
    destination = PlaceSerializer(required=False)
    departure_local = serializers.CharField(max_length=30)
    timezone = serializers.CharField(max_length=80, default="America/Chicago")
    utc_offset_minutes = serializers.IntegerField(
        required=False, min_value=-840, max_value=840
    )
    load_weight_lb = serializers.FloatField(min_value=0, max_value=80000)
    interval_miles = serializers.ChoiceField(choices=[10, 25, 50], default=25)

    def validate(self, attrs):
        if attrs["mode"] == "demo" and not getattr(
            settings, "TEST_FIXTURES_ENABLED", False
        ):
            raise serializers.ValidationError(
                {"mode": "Only live routing is available."}
            )
        if not isfinite(attrs["load_weight_lb"]):
            raise serializers.ValidationError(
                {"load_weight_lb": "Enter a finite weight."}
            )
        try:
            zone = ZoneInfo(attrs["timezone"])
            local = datetime.fromisoformat(attrs["departure_local"])
            if local.tzinfo is not None:
                raise ValueError()
        except (ValueError, ZoneInfoNotFoundError):
            raise serializers.ValidationError(
                {"departure_local": "Choose a valid local date/time and IANA timezone."}
            )
        candidates = {}
        for fold in (0, 1):
            value = local.replace(tzinfo=zone, fold=fold)
            utc = value.astimezone(timezone.utc)
            if utc.astimezone(zone).replace(tzinfo=None) == local:
                candidates[int(value.utcoffset().total_seconds() / 60)] = utc
        if not candidates:
            raise serializers.ValidationError(
                {
                    "departure_local": "This local time does not exist because the clocks change. Choose another time."
                }
            )
        offset = attrs.get("utc_offset_minutes")
        if len(candidates) > 1 and offset not in candidates:
            raise serializers.ValidationError(
                {
                    "utc_offset_minutes": {
                        "message": "This time occurs twice. Select its UTC offset.",
                        "choices": list(candidates),
                    }
                }
            )
        attrs["departure_utc"] = (
            candidates[offset]
            if offset in candidates
            else next(iter(candidates.values()))
        )
        if attrs["mode"] == "live":
            now = datetime.now(timezone.utc)
            if (
                not now - timedelta(minutes=5)
                <= attrs["departure_utc"]
                <= now + timedelta(days=14)
            ):
                raise serializers.ValidationError(
                    {
                        "departure_local": "Live departure must be now or within the next 14 days. Actual forecast coverage is checked per checkpoint."
                    }
                )
            for name in ["origin", "destination"]:
                if name not in attrs:
                    raise serializers.ValidationError(
                        {name: "Select a location from the search suggestions."}
                    )
            a, b = attrs["origin"], attrs["destination"]
            if abs(a["lat"] - b["lat"]) + abs(a["lon"] - b["lon"]) < 0.0001:
                raise serializers.ValidationError(
                    {"destination": "Choose a destination different from the origin."}
                )
        return attrs


@api_view(["GET"])
@throttle_classes([])
def health(request):
    if settings.DATABASES["default"]["ENGINE"] == "django.db.backends.postgresql":
        from django.db import DatabaseError, connection

        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
        except DatabaseError:
            return Response({"status": "unavailable"}, status=503)
    return Response({"status": "ok"})


@api_view(["GET"])
def config(request):
    return Response(
        {
            "live_routing": bool(settings.TOMTOM_API_KEY),
            "bedrock": settings.BEDROCK_ENABLED,
            "groq": bool(settings.GROQ_API_KEY),
        }
    )


@api_view(["GET"])
def places(request):
    query = request.query_params.get("q", "").strip()
    if not 3 <= len(query) <= 200:
        raise serializers.ValidationError({"q": "Enter between 3 and 200 characters."})
    return Response({"results": providers.places(query)})


@api_view(["POST"])
def analyze(request):
    serializer = AnalysisSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    return Response(services.analyze(serializer.validated_data))


@api_view(["POST"])
def corridor(request, analysis_id):
    route_id = request.data.get("route_id")
    if not isinstance(route_id, str) or len(route_id) > 64:
        raise serializers.ValidationError({"route_id": "Select a valid route."})
    return Response(services.corridor(services.get_analysis(analysis_id), route_id))


@api_view(["POST"])
def briefing(request, analysis_id):
    return Response(briefings.briefing(services.get_analysis(analysis_id)))


@never_cache
def index(request):
    path = Path(settings.FRONTEND_DIST) / "index.html"
    if path.is_file():
        return FileResponse(path.open("rb"), content_type="text/html")
    return JsonResponse(
        {
            "message": "TruckMate API is running. Start the frontend with npm run dev, or build it for production."
        }
    )
