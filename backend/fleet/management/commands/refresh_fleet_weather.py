from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from fleet.api import TERMINAL
from fleet.models import Job, Notification
from fleet.operations import notify_admins
from routing.domain import assess
from routing.providers import ServiceError, fetch_weather


class Command(BaseCommand):
    help = "Refresh upcoming checkpoints for saved fleet routes."

    def add_arguments(self, parser):
        parser.add_argument(
            "--loop", action="store_true", help="Refresh every 30 minutes."
        )

    def handle(self, *args, **options):
        from time import sleep

        while True:
            self.refresh()
            if not options["loop"]:
                return
            sleep(1800)

    def refresh(self):
        now = timezone.now()
        candidates = (
            Job.objects.filter(
                company__name="TruckMate",
                deadline__gt=now,
                departure__lte=now + timedelta(hours=48),
            )
            .exclude(status__in=TERMINAL)
            .exclude(route=None)
        )
        for job in candidates.iterator():
            route = job.route
            points = route.get("forecast_points", [])
            start = (
                job.eta - timedelta(seconds=route["duration_s"])
                if job.eta
                else job.departure
            )
            expected = [
                start + timedelta(seconds=point["elapsed_s"]) for point in points
            ]
            upcoming = [
                (point["coordinates"], eta)
                for point, eta in zip(points, expected)
                if now <= eta <= now + timedelta(hours=48)
            ]
            if not upcoming:
                continue
            try:
                forecasts, _ = fetch_weather(
                    [point for point, _ in upcoming], upcoming[0][1], upcoming[-1][1]
                )
            except ServiceError as exc:
                self.stderr.write(f"Job {job.pk}: {exc.code}")
                continue
            if not any(forecasts):
                continue
            levels = [
                assess(forecast.sample(eta), job.load_weight_lb)["level"]
                if forecast
                else "unknown"
                for forecast, (_, eta) in zip(forecasts, upcoming)
            ]
            dangerous = any(level in ("severe", "no_travel") for level in levels)
            if not dangerous and "unknown" in levels:
                continue
            with transaction.atomic():
                current = Job.objects.select_for_update().get(pk=job.pk)
                if current.updated_at != job.updated_at or current.route != route:
                    continue
                current.route = {
                    **route,
                    "forecast_alert": dangerous,
                    "forecast_checked_at": now.isoformat(),
                }
                current.save(update_fields=["route"])
                if dangerous and not route.get("forecast_alert"):
                    message = "Severe weather forecast at an upcoming route checkpoint."
                    notify_admins(current, message)
                    Notification.objects.create(
                        job=current, recipient=current.driver, message=message
                    )
