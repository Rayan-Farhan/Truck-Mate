import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR.parent / ".env", override=False)
DEBUG = os.getenv("DJANGO_DEBUG", "false").lower() == "true"
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY") or (
    secrets.token_urlsafe(48) if DEBUG else ""
)
if not SECRET_KEY:
    raise RuntimeError("DJANGO_SECRET_KEY is required outside development.")
ALLOWED_HOSTS = [
    s.strip()
    for s in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if s.strip()
]
INSTALLED_APPS = ["django.contrib.staticfiles", "rest_framework", "routing"]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "routing.middleware.OriginGuard",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.gzip.GZipMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DATABASES = {}
USE_TZ = True
TIME_ZONE = "UTC"
STATIC_URL = "/assets/"
STATIC_ROOT = BASE_DIR / "staticfiles"
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"
WHITENOISE_ROOT = FRONTEND_DIST
WHITENOISE_INDEX_FILE = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"
# Only the trusted reverse proxy sets this header; direct application ports stay private.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "EXCEPTION_HANDLER": "routing.api.exception_handler",
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.AnonRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"anon": "30/min"},
    "NUM_PROXIES": 1,
}
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "truckmate",
        "TIMEOUT": 900,
        "OPTIONS": {"MAX_ENTRIES": 1800},
    }
}
DATA_UPLOAD_MAX_MEMORY_SIZE = 256_000
TOMTOM_API_KEY = os.getenv("TOMTOM_API_KEY", "")
OPEN_METEO_API_KEY = os.getenv("OPEN_METEO_API_KEY", "")
OPEN_METEO_URL = os.getenv("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
BEDROCK_ENABLED = os.getenv("BEDROCK_ENABLED", "false").lower() == "true"
BEDROCK_MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "amazon.nova-micro-v1:0")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
AI_TIMEOUT_SECONDS = min(10, max(1, float(os.getenv("AI_TIMEOUT_SECONDS", "5"))))
AI_DAILY_LIMIT = max(0, int(os.getenv("AI_DAILY_LIMIT", "100")))
ORIGIN_VERIFY_TOKEN = os.getenv("ORIGIN_VERIFY_TOKEN", "")
WEATHER_LOCATION_LIMIT_PER_MINUTE = int(
    os.getenv("WEATHER_LOCATION_LIMIT_PER_MINUTE", "450")
)
WEATHER_LOCATION_LIMIT_PER_HOUR = int(
    os.getenv("WEATHER_LOCATION_LIMIT_PER_HOUR", "4000")
)
WEATHER_LOCATION_LIMIT_PER_DAY = int(
    os.getenv("WEATHER_LOCATION_LIMIT_PER_DAY", "8000")
)
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {"httpx": {"level": "WARNING"}, "httpcore": {"level": "WARNING"}},
}
