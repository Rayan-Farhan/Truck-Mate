import json
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .models import Company, Job, Membership

ORIGIN = {"label": "Chicago, IL", "lat": 41.8781, "lon": -87.6298}
DESTINATION = {"label": "Denver, CO", "lat": 39.7392, "lon": -104.9903}


@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    FLEET_PUBLIC_ORIGIN="https://truckmate.example",
    FLEET_EMAIL_ENABLED=True,
    ORIGIN_VERIFY_TOKEN="",
)
class FleetWorkflowTests(TestCase):
    def test_password_recovery_sends_email_only_for_an_existing_account(self):
        known = self.request(
            "POST", "password/request", {"username": self.admin.user.email}
        )
        unknown = self.request(
            "POST", "password/request", {"username": "absent@example.com"}
        )
        self.assertEqual(known.status_code, 200)
        self.assertEqual(known.json(), unknown.json())
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, [self.admin.user.email])
        self.assertIn("https://truckmate.example/fleet/reset#", mail.outbox[0].body)

    def test_registration_creates_isolated_admin_and_allows_sign_in(self):
        email = "new-admin@example.com"
        data = {
            "company": "New Carrier",
            "email": email,
            "password": "A-strong-new-fleet#8",
        }
        response = self.request("POST", "register", data)
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(self.request("POST", "register", data).status_code, 409)
        response = self.request(
            "POST", "login", {"username": email, "password": data["password"]}
        )
        self.assertEqual(response.json()["user"]["role"], "admin")
        self.assertEqual(response.json()["user"]["company"], "New Carrier")
        self.assertEqual(self.request("GET", "drivers").json(), [])

    def test_truck_assignments_enforce_capacity_and_company(self):
        self.client.force_login(self.admin.user)
        truck = {"registration": "TM-101", "model": "Cascadia", "capacity_lb": 10000}
        result = self.request("POST", "trucks", truck)
        self.assertEqual(result.status_code, 201, result.content)
        pk = result.json()["id"]
        self.assertEqual(
            self.request("POST", "jobs", {**self.job_input, "truck": pk}).status_code,
            400,
        )
        self.assertEqual(
            self.request("PATCH", f"trucks/{pk}", {"capacity_lb": 20000}).status_code,
            200,
        )
        result = self.request("POST", "jobs", {**self.job_input, "truck": pk})
        self.assertEqual(result.status_code, 201, result.content)
        self.assertEqual(result.json()["truck_registration"], "TM-101")
        self.assertEqual(
            self.request("POST", "jobs", {**self.job_input, "truck": pk}).status_code,
            400,
        )
        self.assertEqual(self.request("DELETE", f"trucks/{pk}").status_code, 400)
        self.client.force_login(self.outside.user)
        self.assertEqual(self.request("GET", "trucks").json(), [])
        self.assertEqual(
            self.request("PATCH", f"trucks/{pk}", {"available": False}).status_code, 404
        )

    def setUp(self):
        cache.clear()
        self.company = Company.objects.create(name="TruckMate Test Fleet")
        self.admin = self.member(self.company, "admin", "admin@example.com")
        self.driver = self.member(self.company, "driver", "driver@example.com")
        self.other_driver = self.member(
            self.company, "driver", "other-driver@example.com"
        )
        self.outside = self.member(
            Company.objects.create(name="Other fleet"),
            "admin",
            "other-admin@example.com",
        )
        self.departure = timezone.now() + timedelta(hours=2)
        self.deadline = self.departure + timedelta(hours=4)
        self.job_input = {
            "driver": self.driver.pk,
            "origin": ORIGIN,
            "destination": DESTINATION,
            "departure": self.departure.isoformat(),
            "deadline": self.deadline.isoformat(),
            "load_weight_lb": 15000,
        }

    def member(self, company, role, email):
        user = get_user_model().objects.create_user(
            email, email, "A-strong-test-password#1"
        )
        return Membership.objects.create(user=user, role=role, company=company)

    def request(self, method, path, data=None, client=None, **headers):
        client = client or self.client
        return client.generic(
            method,
            f"/api/fleet/{path}",
            json.dumps(data) if data is not None else "",
            content_type="application/json",
            **headers,
        )

    def create_job(self):
        self.client.force_login(self.admin.user)
        result = self.request("POST", "jobs", self.job_input)
        self.assertEqual(result.status_code, 201, result.content)
        return result.json()["id"]

    def test_end_to_end_assignment_route_delay_and_delivery(self):
        pk = self.create_job()
        self.client.force_login(self.driver.user)
        self.assertEqual(self.request("GET", f"jobs/{pk}").json()["origin"], ORIGIN)
        arrival = self.deadline - timedelta(hours=1)
        cache.set(
            "analysis:route-test",
            {
                "origin": ORIGIN,
                "destination": DESTINATION,
                "load_weight_lb": 15000,
                "routes": [
                    {
                        "id": "r1",
                        "label": "I-80",
                        "road": "I-80",
                        "distance_m": 1000,
                        "duration_s": 200,
                        "worst_level": "low",
                        "arrival_utc": arrival.isoformat(),
                    }
                ],
            },
        )
        result = self.request(
            "POST",
            f"jobs/{pk}/updates",
            {"analysis_id": "route-test", "route_id": "r1"},
        )
        self.assertEqual(result.status_code, 200, result.content)
        cache.clear()
        self.assertEqual(Job.objects.get(pk=pk).eta, arrival)
        self.assertEqual(Job.objects.get(pk=pk).route["label"], "I-80")
        self.assertEqual(
            self.request(
                "POST", f"jobs/{pk}/updates", {"status": "en_route"}
            ).status_code,
            200,
        )
        later = (self.deadline + timedelta(hours=1)).isoformat()
        result = self.request(
            "POST",
            f"jobs/{pk}/updates",
            {"status": "delayed", "eta": later, "note": "Road closure"},
        )
        self.assertEqual(result.json()["risk"], "at_risk")
        self.client.force_login(self.admin.user)
        self.assertEqual(
            self.request("GET", f"jobs/{pk}").json()["history"][0]["note"],
            "Road closure",
        )
        self.client.force_login(self.driver.user)
        result = self.request("POST", f"jobs/{pk}/updates", {"status": "delivered"})
        self.assertEqual(result.json()["risk"], "delivered_on_time")
        self.assertEqual(
            self.request(
                "POST", f"jobs/{pk}/updates", {"status": "en_route"}
            ).status_code,
            400,
        )

    def test_permissions_and_reassignment(self):
        pk = self.create_job()
        for user in (self.other_driver.user, self.outside.user):
            self.client.force_login(user)
            self.assertEqual(self.request("GET", "jobs").json(), [])
            self.assertEqual(self.request("GET", f"jobs/{pk}").status_code, 404)
            self.assertEqual(
                self.request(
                    "POST", f"jobs/{pk}/updates", {"status": "delivered"}
                ).status_code,
                404,
            )
        self.client.force_login(self.driver.user)
        self.assertEqual(self.request("GET", "drivers").status_code, 403)
        self.assertEqual(
            self.request(
                "POST", f"jobs/{pk}/updates", {"status": "cancelled"}
            ).status_code,
            403,
        )
        self.client.force_login(self.admin.user)
        self.assertEqual(
            self.request(
                "PUT", f"jobs/{pk}", {**self.job_input, "driver": self.other_driver.pk}
            ).status_code,
            200,
        )
        self.client.force_login(self.driver.user)
        self.assertEqual(self.request("GET", f"jobs/{pk}").status_code, 404)
        self.client.force_login(self.admin.user)
        self.assertEqual(
            self.request(
                "PATCH", f"drivers/{self.other_driver.pk}", {"active": False}
            ).status_code,
            200,
        )
        self.client.force_login(self.other_driver.user)
        self.assertIsNone(self.request("GET", "session").json()["user"])
        self.assertEqual(self.request("GET", "jobs").status_code, 403)

    def test_invitation_password_and_csrf(self):
        self.client.force_login(self.admin.user)
        result = self.request(
            "POST", "drivers", {"name": "New Driver", "email": "new@example.com"}
        )
        self.assertEqual(result.status_code, 201, result.content)
        link = mail.outbox[0].body.splitlines()[-1]
        query = {
            key: values[0] for key, values in parse_qs(urlparse(link).fragment).items()
        }
        client = Client(enforce_csrf_checks=True)
        password = "Valid-test-passphrase#7"
        self.assertEqual(
            self.request(
                "POST", "password/reset", {**query, "password": password}, client
            ).status_code,
            403,
        )
        response = self.request("GET", "session", client=client)
        self.assertIn("no-store", response.headers["Cache-Control"])
        token = client.cookies["csrftoken"].value
        self.assertEqual(
            self.request(
                "POST",
                "password/reset",
                {**query, "password": password},
                client,
                HTTP_X_CSRFTOKEN=token,
            ).status_code,
            200,
        )
        self.assertEqual(
            self.request(
                "POST",
                "password/reset",
                {**query, "password": password},
                client,
                HTTP_X_CSRFTOKEN=token,
            ).status_code,
            400,
        )
        response = self.request(
            "POST",
            "login",
            {"username": "new@example.com", "password": password},
            client,
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["user"]["role"], "driver")
        self.assertEqual(
            self.request("GET", "session", client=client).json()["user"]["role"],
            "driver",
        )
