import json
import logging
from datetime import timedelta
from urllib.parse import urlencode

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST
from rest_framework import serializers
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
)
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle

from routing.api import PlaceSerializer

from .models import Job, JobUpdate, Membership

User = get_user_model()
logger = logging.getLogger(__name__)
TERMINAL = {Job.Status.DELIVERED, Job.Status.CANCELLED}


def member_for(user):
    if user.is_authenticated:
        return (
            Membership.objects.select_related("company")
            .filter(user=user, active=True)
            .first()
        )
    return None


def identity(member):
    if member is None:
        return None
    return {
        "id": member.pk,
        "username": member.user.username,
        "role": member.role,
        "company": member.company.name,
    }


def error(message, status=400):
    return JsonResponse({"error": {"message": message}}, status=status)


def credentials(request):
    try:
        data = json.loads(request.body)
        if isinstance(data, dict):
            return {key: value for key, value in data.items() if isinstance(value, str)}
    except (ValueError, UnicodeDecodeError):
        pass
    return {}


class AccountThrottle(AnonRateThrottle):
    rate = "10/min"
    scope = "fleet_account"

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": self.scope,
            "ident": self.get_ident(request),
        }


@never_cache
@ensure_csrf_cookie
@require_GET
def session(request):
    return JsonResponse(
        {
            "user": identity(member_for(request.user)),
            "email_enabled": settings.FLEET_EMAIL_ENABLED,
        }
    )


@never_cache
@require_POST
@csrf_protect
def sign_in(request):
    if not AccountThrottle().allow_request(request, None):
        return error("Too many account requests. Try again shortly.", 429)
    data = credentials(request)
    user = authenticate(
        request,
        username=data.get("username", "").strip().lower(),
        password=data.get("password", ""),
    )
    member = member_for(user) if user else None
    if member is None:
        return error("Invalid credentials or inactive account.", 401)
    login(request, user)
    return JsonResponse({"user": identity(member)})


@never_cache
@require_POST
@csrf_protect
def sign_out(request):
    logout(request)
    return JsonResponse({"user": None})


def account_link(user):
    query = urlencode(
        {"user": user.pk, "token": default_token_generator.make_token(user)}
    )
    return f"/fleet/reset#{query}"


def send_account_link(request, user, subject):
    origin = settings.FLEET_PUBLIC_ORIGIN or request.build_absolute_uri("/").rstrip("/")
    link = f"{origin}{account_link(user)}"
    send_mail(
        subject,
        f"Set your TruckMate password using this link:\n\n{link}",
        None,
        [user.email],
    )


@never_cache
@require_POST
@csrf_protect
def request_password(request):
    if not settings.FLEET_EMAIL_ENABLED:
        return error("Ask your fleet administrator for a password reset link.", 503)
    if not AccountThrottle().allow_request(request, None):
        return error("Too many account requests. Try again shortly.", 429)
    username = credentials(request).get("username", "").strip().lower()
    user = User.objects.filter(
        username=username, email__gt="", is_active=True, membership__active=True
    ).first()
    if user:
        try:
            send_account_link(request, user, "Reset your TruckMate password")
        except Exception:
            logger.exception("TruckMate account email failed")
    return JsonResponse({"ok": True})


@never_cache
@require_POST
@csrf_protect
@transaction.atomic
def reset_password(request):
    if not AccountThrottle().allow_request(request, None):
        return error("Too many account requests. Try again shortly.", 429)
    data = credentials(request)
    identifier = data.get("user", "")
    if not identifier.isascii() or not identifier.isdecimal() or len(identifier) > 18:
        return error("This password link is invalid or expired.")
    user = (
        User.objects.select_for_update()
        .filter(
            pk=int(identifier),
            is_active=True,
            membership__active=True,
        )
        .first()
    )
    if user is None or not default_token_generator.check_token(
        user, data.get("token", "")
    ):
        return error("This password link is invalid or expired.")
    password = data.get("password", "")
    try:
        validate_password(password, user)
    except ValidationError as exc:
        return error(" ".join(exc.messages))
    user.set_password(password)
    user.save(update_fields=["password"])
    return JsonResponse({"ok": True})


def require_member(request, role=None):
    member = member_for(request.user)
    if member is None or (role and member.role != role):
        raise PermissionDenied()
    return member


def driver_data(member):
    return {
        "id": member.pk,
        "email": member.user.email,
        "active": member.active,
        "name": member.user.get_full_name() or member.user.username,
    }


class InviteSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=150)
    name = serializers.CharField(max_length=150)


class DriverSerializer(serializers.Serializer):
    active = serializers.BooleanField()


@never_cache
@api_view(["GET", "POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def drivers(request):
    member = require_member(request, Membership.Role.ADMIN)
    roster = Membership.objects.filter(
        company=member.company, role=Membership.Role.DRIVER
    )
    if request.method == "GET":
        return Response(
            [
                driver_data(driver)
                for driver in roster.select_related("user").order_by("pk")
            ]
        )
    form = InviteSerializer(data=request.data)
    form.is_valid(raise_exception=True)
    email = form.validated_data["email"].lower()
    existing = (
        roster.filter(user__username=email, active=True).select_related("user").first()
    )
    if existing and not existing.user.has_usable_password():
        invited = existing
    else:
        try:
            with transaction.atomic():
                user = User.objects.create_user(
                    username=email, email=email, first_name=form.validated_data["name"]
                )
                invited = Membership.objects.create(
                    user=user,
                    company=member.company,
                    role=Membership.Role.DRIVER,
                )
        except IntegrityError:
            raise serializers.ValidationError(
                {"email": "This email is already registered."}
            )
    if not settings.FLEET_EMAIL_ENABLED:
        return Response(
            {**driver_data(invited), "setup_url": account_link(invited.user)},
            status=201,
        )
    try:
        send_account_link(request, invited.user, "You’re invited to TruckMate")
    except Exception:
        logger.exception("TruckMate driver invitation failed")
        return Response(
            {
                "error": {
                    "message": "Email delivery failed. Submit the invitation again to resend."
                }
            },
            status=503,
        )
    return Response(driver_data(invited), status=201)


@never_cache
@api_view(["POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def driver_setup_link(request, pk):
    member = require_member(request, Membership.Role.ADMIN)
    target = get_object_or_404(
        Membership.objects.select_related("user"),
        pk=pk,
        company=member.company,
        role=Membership.Role.DRIVER,
        active=True,
    )
    return Response({"setup_url": account_link(target.user)})


@never_cache
@api_view(["PATCH"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def driver(request, pk):
    member = require_member(request, Membership.Role.ADMIN)
    form = DriverSerializer(data=request.data)
    form.is_valid(raise_exception=True)
    target = get_object_or_404(
        Membership.objects.select_related("user"),
        pk=pk,
        company=member.company,
        role=Membership.Role.DRIVER,
    )
    target.active = form.validated_data["active"]
    target.save(update_fields=["active"])
    return Response(driver_data(target))


class JobInput(serializers.Serializer):
    driver = serializers.IntegerField(min_value=1)
    origin = PlaceSerializer()
    destination = PlaceSerializer()
    departure = serializers.DateTimeField()
    deadline = serializers.DateTimeField()
    load_weight_lb = serializers.IntegerField(min_value=0, max_value=80000)

    def validate(self, attrs):
        if attrs["deadline"] <= attrs["departure"]:
            raise serializers.ValidationError(
                {"deadline": "Choose a deadline after departure."}
            )
        a, b = attrs["origin"], attrs["destination"]
        if abs(a["lat"] - b["lat"]) + abs(a["lon"] - b["lon"]) < 0.0001:
            raise serializers.ValidationError(
                {"destination": "Choose a different destination."}
            )
        attrs["driver"] = get_object_or_404(
            Membership.objects.select_for_update(),
            pk=attrs["driver"],
            company=self.context["member"].company,
            active=True,
            role=Membership.Role.DRIVER,
        )
        return attrs


class UpdateInput(serializers.Serializer):
    status = serializers.ChoiceField(choices=Job.Status.choices, required=False)
    eta = serializers.DateTimeField(required=False)
    note = serializers.CharField(max_length=500, required=False)
    analysis_id = serializers.CharField(max_length=64, required=False)
    route_id = serializers.CharField(max_length=64, required=False)


def record(job, member, note=""):
    JobUpdate.objects.create(
        job=job, actor=member, status=job.status, eta=job.eta, note=note
    )


def risk(job):
    now = timezone.now()
    if job.status == Job.Status.CANCELLED:
        return "cancelled"
    if job.delivered_at:
        return (
            "delivered_late" if job.delivered_at > job.deadline else "delivered_on_time"
        )
    if job.deadline <= now:
        return "overdue"
    if job.eta is None:
        return "missing_eta"
    if job.status != Job.Status.ASSIGNED and now - job.eta_updated_at > timedelta(
        hours=2
    ):
        return "stale_eta"
    return "at_risk" if job.eta > job.deadline else "on_track"


def job_data(job, detail=False):
    data = {
        key: getattr(job, key)
        for key in (
            "id",
            "driver_id",
            "origin",
            "destination",
            "departure",
            "deadline",
            "load_weight_lb",
            "status",
            "eta",
            "eta_updated_at",
            "route",
            "delivered_at",
            "updated_at",
        )
    }
    data.update(driver_name=driver_data(job.driver)["name"], risk=risk(job))
    if detail:
        data["history"] = list(
            job.history.order_by("-pk").values("status", "eta", "note", "created_at")
        )
    return data


def scoped_jobs(member):
    queryset = Job.objects.filter(company=member.company).select_related("driver__user")
    if member.role == Membership.Role.DRIVER:
        queryset = queryset.filter(driver=member)
    return queryset


@never_cache
@api_view(["GET", "POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
@transaction.atomic
def jobs(request):
    member = require_member(request)
    if request.method == "GET":
        return Response(
            [job_data(item) for item in scoped_jobs(member).order_by("-updated_at")]
        )
    require_member(request, Membership.Role.ADMIN)
    form = JobInput(data=request.data, context={"member": member})
    form.is_valid(raise_exception=True)
    item = Job.objects.create(company=member.company, **form.validated_data)
    record(item, member, "Job assigned")
    return Response(job_data(item, detail=True), status=201)


@never_cache
@api_view(["GET", "PUT"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
@transaction.atomic
def job(request, pk):
    member = require_member(request)
    queryset = scoped_jobs(member)
    if request.method == "GET":
        return Response(job_data(get_object_or_404(queryset, pk=pk), detail=True))
    require_member(request, Membership.Role.ADMIN)
    item = get_object_or_404(queryset.select_for_update(of=("self",)), pk=pk)
    if item.status in TERMINAL:
        raise serializers.ValidationError("This job is closed.")
    form = JobInput(data=request.data, context={"member": member})
    form.is_valid(raise_exception=True)
    data = form.validated_data
    if any(
        getattr(item, key) != data[key]
        for key in ("driver", "origin", "destination", "departure", "load_weight_lb")
    ):
        item.route = item.eta = item.eta_updated_at = None
    if item.driver != data["driver"]:
        item.status = Job.Status.ASSIGNED
    for key, value in data.items():
        setattr(item, key, value)
    item.save()
    record(item, member, "Assignment updated")
    return Response(job_data(item, detail=True))


def confirm_route(item, data):
    from routing.services import get_analysis

    if not data.get("analysis_id") or not data.get("route_id"):
        raise serializers.ValidationError("Choose a route from a current analysis.")
    analysis = get_analysis(data["analysis_id"])
    route = next(
        (route for route in analysis["routes"] if route["id"] == data["route_id"]), None
    )
    if (
        route is None
        or analysis["origin"] != item.origin
        or analysis["destination"] != item.destination
        or analysis["load_weight_lb"] != item.load_weight_lb
    ):
        raise serializers.ValidationError(
            "Plan a route with the assigned locations and cargo weight."
        )
    item.route = {
        key: route[key]
        for key in ("id", "label", "road", "distance_m", "duration_s", "worst_level")
    }
    item.eta = serializers.DateTimeField().to_internal_value(route["arrival_utc"])
    item.eta_updated_at = timezone.now()


@never_cache
@api_view(["POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
@transaction.atomic
def update_job(request, pk):
    member = require_member(request)
    item = get_object_or_404(scoped_jobs(member).select_for_update(of=("self",)), pk=pk)
    form = UpdateInput(data=request.data)
    form.is_valid(raise_exception=True)
    data = form.validated_data
    status = data.get("status")
    if item.status in TERMINAL:
        raise serializers.ValidationError("This job is closed.")
    if member.role == Membership.Role.ADMIN:
        if status != Job.Status.CANCELLED or set(data) - {"status", "note"}:
            raise PermissionDenied()
    elif status not in (
        None,
        Job.Status.EN_ROUTE,
        Job.Status.DELAYED,
        Job.Status.DELIVERED,
    ):
        raise PermissionDenied()
    if status == Job.Status.DELAYED and not (data.get("eta") and data.get("note")):
        raise serializers.ValidationError(
            "A delay requires a revised ETA and a reason."
        )
    if "analysis_id" in data or "route_id" in data:
        if set(data) != {"analysis_id", "route_id"}:
            raise serializers.ValidationError(
                "Confirm a route separately from a progress update."
            )
        confirm_route(item, data)
        data["note"] = "Route confirmed"
    elif not status and "eta" not in data:
        raise serializers.ValidationError("Choose a status or provide a new ETA.")
    if "eta" in data:
        item.eta = data["eta"]
        item.eta_updated_at = timezone.now()
    if status:
        item.status = status
    if status == Job.Status.DELIVERED:
        item.delivered_at = timezone.now()
    item.save()
    record(item, member, data.get("note", ""))
    return Response(job_data(item, detail=True))
