from django.urls import include, path, re_path
from routing import api

urlpatterns = [
    path("api/fleet/", include("fleet.urls")),
    path("api/health", api.health),
    path("api/config", api.config),
    path("api/places", api.places),
    path("api/analyses", api.analyze),
    path("api/analyses/<str:analysis_id>/corridor", api.corridor),
    path("api/analyses/<str:analysis_id>/briefing", api.briefing),
    path("", api.index),
    re_path(r"^fleet(?:/.*)?$", api.index),
]
