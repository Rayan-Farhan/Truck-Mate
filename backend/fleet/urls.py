from django.urls import path

from . import api, operations

urlpatterns = [
    path("session", api.session),
    path("login", api.sign_in),
    path("logout", api.sign_out),
    path("password/request", api.request_password),
    path("password/reset", api.reset_password),
    path("drivers", api.drivers),
    path("admins", api.drivers, {"role": "admin"}),
    path("drivers/<int:pk>", api.driver),
    path("drivers/<int:pk>/setup-link", api.driver_setup_link),
    path("jobs", api.jobs),
    path("trucks", api.trucks),
    path("trucks/<int:pk>", api.trucks),
    path("jobs/<int:pk>", api.job),
    path("jobs/<int:pk>/updates", api.update_job),
    path("jobs/<int:pk>/operations", operations.job_operations),
    path("jobs/<int:pk>/proof/<str:kind>", operations.proof_image),
    path("trucks/<int:pk>/records", operations.vehicle_records),
    path("notifications", operations.inbox),
    path("reports", operations.reports),
    path("insights", operations.dispatch_insights),
    path("assistant", operations.assistant),
    path("jobs/<int:pk>/receipt-extraction", operations.extract_receipt),
]
