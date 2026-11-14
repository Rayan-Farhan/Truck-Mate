from django.conf import settings
from django.db import models


class Company(models.Model):
    name = models.CharField(max_length=150)


class Membership(models.Model):
    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"
        DRIVER = "driver", "Driver"

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    company = models.ForeignKey(Company, on_delete=models.PROTECT)
    role = models.CharField(max_length=6, choices=Role.choices)
    active = models.BooleanField(default=True)


class Truck(models.Model):
    company = models.ForeignKey(Company, on_delete=models.PROTECT)
    registration = models.CharField(max_length=32)
    model = models.CharField(max_length=100)
    capacity_lb = models.PositiveIntegerField()
    available = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["company", "registration"],
                name="fleet_truck_registration_unique",
            )
        ]


class Job(models.Model):
    class Status(models.TextChoices):
        ASSIGNED = "assigned", "Assigned"
        ACCEPTED = "accepted", "Accepted"
        ARRIVED = "arrived", "Arrived at pickup"
        PICKED_UP = "picked_up", "Picked up"
        EN_ROUTE = "en_route", "En route"
        DELAYED = "delayed", "Delayed"
        DELIVERED = "delivered", "Delivered"
        CANCELLED = "cancelled", "Cancelled"

    company = models.ForeignKey(Company, on_delete=models.PROTECT)
    driver = models.ForeignKey(Membership, on_delete=models.PROTECT)
    truck = models.ForeignKey(Truck, on_delete=models.PROTECT, null=True, blank=True)
    origin = models.JSONField()
    destination = models.JSONField()
    departure = models.DateTimeField()
    deadline = models.DateTimeField()
    load_weight_lb = models.PositiveIntegerField()
    cargo_type = models.CharField(max_length=100, blank=True)
    customer_name = models.CharField(max_length=150, blank=True)
    instructions = models.CharField(max_length=1000, blank=True)
    status = models.CharField(
        max_length=10, choices=Status.choices, default=Status.ASSIGNED
    )
    eta = models.DateTimeField(null=True)
    eta_updated_at = models.DateTimeField(null=True)
    route = models.JSONField(null=True)
    delivered_at = models.DateTimeField(null=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=["company", "driver", "status"])]


class JobUpdate(models.Model):
    job = models.ForeignKey(Job, related_name="history", on_delete=models.CASCADE)
    actor = models.ForeignKey(Membership, on_delete=models.PROTECT)
    status = models.CharField(max_length=10, choices=Job.Status.choices)
    eta = models.DateTimeField(null=True)
    note = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
