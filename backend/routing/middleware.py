import secrets
from django.conf import settings
from django.http import HttpResponseNotFound


class OriginGuard:
    """An extra origin check; EC2's security group also admits only CloudFront."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        expected = settings.ORIGIN_VERIFY_TOKEN
        if (
            expected
            and request.path != "/api/health"
            and not secrets.compare_digest(
                request.headers.get("X-TruckMate-Origin", ""), expected
            )
        ):
            return HttpResponseNotFound()
        return self.get_response(request)
