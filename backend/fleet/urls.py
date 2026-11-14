from django.urls import path

from . import api

urlpatterns = [
    path("session", api.session),
    path("login", api.sign_in),
    path("logout", api.sign_out),
    path("password/request", api.request_password),
    path("password/reset", api.reset_password),
    path("drivers", api.drivers),
    path("drivers/<int:pk>", api.driver),
    path("drivers/<int:pk>/setup-link", api.driver_setup_link),
    path("jobs", api.jobs),
    path("jobs/<int:pk>", api.job),
    path("jobs/<int:pk>/updates", api.update_job),
]
