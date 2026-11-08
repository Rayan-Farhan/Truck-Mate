from django.urls import path
from routing import api

urlpatterns = [
    path("api/health", api.health),
    path("api/config", api.config),
    path("api/places", api.places),
    path("api/analyses", api.analyze),
    path("api/analyses/<str:analysis_id>/corridor", api.corridor),
    path("api/analyses/<str:analysis_id>/briefing", api.briefing),
    path("", api.index),
]
