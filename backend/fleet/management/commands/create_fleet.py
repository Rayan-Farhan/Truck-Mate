from getpass import getpass

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email
from django.db import transaction

from fleet.models import Company, Membership


class Command(BaseCommand):
    help = "Create a company and its first fleet administrator."

    def add_arguments(self, parser):
        parser.add_argument("company")
        parser.add_argument("email")

    def handle(self, *args, **options):
        email = options["email"].strip().lower()
        name = options["company"].strip()
        User = get_user_model()
        if not name or len(name) > 150 or len(email) > 150:
            raise CommandError("Provide a valid company name and email.")
        if User.objects.filter(username=email).exists():
            raise CommandError("An account already uses this email.")
        user = User(username=email, email=email)
        try:
            validate_email(email)
            password = getpass("Admin password: ")
            validate_password(password, user)
        except ValidationError as exc:
            raise CommandError(" ".join(exc.messages)) from exc
        if password != getpass("Confirm password: "):
            raise CommandError("Passwords do not match.")
        with transaction.atomic():
            user.set_password(password)
            user.save()
            company = Company.objects.create(name=name)
            Membership.objects.create(
                user=user, company=company, role=Membership.Role.ADMIN
            )
        self.stdout.write(
            self.style.SUCCESS(f"Created fleet {company.pk} and administrator.")
        )
