"""
Django settings for opentd project.
"""

import os
from pathlib import Path

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent


def _load_env_file(path: Path) -> None:
    """Load KEY=VALUE lines into os.environ without overwriting existing vars."""
    if not path.is_file():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key:
            continue
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)


_load_env_file(BASE_DIR / ".env")
_load_env_file(BASE_DIR / "opentd" / ".env")


# Quick-start development settings - unsuitable for production
# See https://docs.djangoproject.com/en/6.0/howto/deployment/checklist/

# Prefer DJANGO_SECRET_KEY (compose/prod); fall back to SECRET_KEY for local .env.
SECRET_KEY = os.environ.get(
    "DJANGO_SECRET_KEY",
    os.environ.get(
        "SECRET_KEY",
        "django-insecure-opentd-dev-only-change-me-in-production",
    ),
)

DEBUG = os.environ.get("DEBUG", "True").lower() in ("1", "true", "yes", "on")

_allowed = os.environ.get("ALLOWED_HOSTS", "localhost,127.0.0.1").strip()
ALLOWED_HOSTS = (
    ["*"]
    if _allowed == "*"
    else [h.strip() for h in _allowed.split(",") if h.strip()]
)
if DEBUG and "*" not in ALLOWED_HOSTS:
    for host in ("localhost", "127.0.0.1", "[::1]", "testserver"):
        if host not in ALLOWED_HOSTS:
            ALLOWED_HOSTS.append(host)

CSRF_TRUSTED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CSRF_TRUSTED_ORIGINS",
        "http://localhost:8000,http://127.0.0.1:8000,http://localhost:8080,http://127.0.0.1:8080",
    ).split(",")
    if o.strip()
]

# Reverse proxy terminates TLS; honor forwarded scheme so CSRF origin checks work.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True


# Application definition

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.sites",
    # Third-party
    "allauth",
    "allauth.account",
    "anymail",
    "django_htmx",
    # Local
    "core.apps.CoreConfig",
    "opentd_docs.apps.OpentdDocsConfig",
]


MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "core.middleware.RequestBodySizeMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django_htmx.middleware.HtmxMiddleware",
    "allauth.account.middleware.AccountMiddleware",
    "core.middleware.ContentSecurityPolicyMiddleware",
]

ROOT_URLCONF = "opentd.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": not DEBUG,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "core.context_processors.site_settings",
            ],
        },
    },
]

# In DEBUG, skip the cached template loader so template edits show immediately.
if DEBUG:
    TEMPLATES[0]["OPTIONS"]["loaders"] = [
        "django.template.loaders.filesystem.Loader",
        "django.template.loaders.app_directories.Loader",
    ]

WSGI_APPLICATION = "opentd.wsgi.application"


# Database
# https://docs.djangoproject.com/en/6.0/ref/settings/#databases

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        # SQLITE_PATH is set in docker-compose for a host-mounted data volume.
        "NAME": Path(os.environ.get("SQLITE_PATH", str(BASE_DIR / "db.sqlite3"))),
        "OPTIONS": {
            "timeout": 30,
        },
    }
}


# Password validation
# https://docs.djangoproject.com/en/6.0/ref/settings/#auth-password-validators

AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]


# Internationalization
# https://docs.djangoproject.com/en/6.0/topics/i18n/

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True


# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/6.0/howto/static-files/

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [
    BASE_DIR / "static",
]

# User-uploaded media
MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "mediafiles"

# Default primary key field type
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Site framework (required by django-allauth)
SITE_ID = 1

# Public branding / absolute links in email
SITE_NAME = os.environ.get("SITE_NAME", "OpenTD.org").strip() or "OpenTD.org"
SITE_DOMAIN = os.environ.get("SITE_DOMAIN", "opentd.org").strip() or "opentd.org"
PUBLIC_BASE_URL = (
    os.environ.get("PUBLIC_BASE_URL", "https://opentd.org").strip().rstrip("/")
    or "https://opentd.org"
)


# ---------------------------------------------------------------------------
# Auth — django-allauth (email login + mandatory verification)
# ---------------------------------------------------------------------------
AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
    "allauth.account.auth_backends.AuthenticationBackend",
]

LOGIN_URL = "account_login"
LOGIN_REDIRECT_URL = "dashboard"
LOGOUT_REDIRECT_URL = "home"
ACCOUNT_LOGOUT_REDIRECT_URL = "home"
# After confirming email (and auto-login), land on the creator dashboard.
ACCOUNT_EMAIL_CONFIRMATION_AUTHENTICATED_REDIRECT_URL = "/dashboard/"
ACCOUNT_EMAIL_CONFIRMATION_ANONYMOUS_REDIRECT_URL = "/accounts/login/"

# Public credit uses username (not email). Login accepts either email or username.
ACCOUNT_LOGIN_METHODS = {"email", "username"}
ACCOUNT_SIGNUP_FIELDS = ["email*", "username*", "password1*", "password2*"]
ACCOUNT_EMAIL_VERIFICATION = "mandatory"
ACCOUNT_CONFIRM_EMAIL_ON_GET = True
ACCOUNT_LOGIN_ON_EMAIL_CONFIRMATION = True
ACCOUNT_EMAIL_SUBJECT_PREFIX = "[OpenTD.org] "
ACCOUNT_EMAIL_CONFIRMATION_EXPIRE_DAYS = 3
ACCOUNT_SESSION_REMEMBER = True
ACCOUNT_UNIQUE_EMAIL = True
ACCOUNT_PREVENT_ENUMERATION = True
# Usernames shown publicly when crediting game authors — keep them human-friendly.
ACCOUNT_USERNAME_MIN_LENGTH = 3
ACCOUNT_USERNAME_BLACKLIST = [
    "admin",
    "administrator",
    "root",
    "opentd",
    "support",
    "moderator",
    "staff",
    "null",
    "undefined",
]


# ---------------------------------------------------------------------------
# Email (Resend via django-anymail; console backend when no API key)
# ---------------------------------------------------------------------------
# Resend is used as the outbound mail provider (API, not raw SMTP sockets).
# Set RESEND_API_KEY in the environment (or .env). Without it, mail is printed
# to the console so local signup/verification still works.
#
# IMPORTANT: empty env vars (e.g. compose DEFAULT_FROM_EMAIL: ${X:-}) must not
# override the default — os.environ.get("K", default) returns "" if K is set blank.
def _env_nonempty(name: str, default: str = "") -> str:
    val = os.environ.get(name)
    if val is None:
        return default
    val = val.strip()
    return val if val else default


RESEND_API_KEY = _env_nonempty("RESEND_API_KEY", "")
_DEFAULT_FROM = f"{SITE_NAME} <support@opentd.org>"
DEFAULT_FROM_EMAIL = _env_nonempty("DEFAULT_FROM_EMAIL", _DEFAULT_FROM)
SERVER_EMAIL = _env_nonempty("SERVER_EMAIL", DEFAULT_FROM_EMAIL)

if RESEND_API_KEY:
    EMAIL_BACKEND = "anymail.backends.resend.EmailBackend"
    ANYMAIL = {
        "RESEND_API_KEY": RESEND_API_KEY,
    }
else:
    EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"


# ---------------------------------------------------------------------------
# django-allauth — closed beta adapter + forms
# ---------------------------------------------------------------------------
ACCOUNT_ADAPTER = "core.adapters.AccountAdapter"
ACCOUNT_FORMS = {
    "signup": "core.forms.ClosedBetaSignupForm",
    "reset_password": "core.forms.RateLimitedResetPasswordForm",
}


# ---------------------------------------------------------------------------
# Cloudflare Turnstile (signup captcha)
# Create a widget at https://dash.cloudflare.com/ → Turnstile → Add site
# Widget domains: opentd.org, localhost
# Copy Site Key + Secret Key into env.
# ---------------------------------------------------------------------------
TURNSTILE_SITE_KEY = os.environ.get("TURNSTILE_SITE_KEY", "").strip()
TURNSTILE_SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY", "").strip()


# ---------------------------------------------------------------------------
# Request / document size guards
# ---------------------------------------------------------------------------
MAX_REQUEST_BODY_BYTES = int(os.environ.get("MAX_REQUEST_BODY_BYTES", str(262_144)))
MAX_DOCUMENT_BYTES = int(os.environ.get("MAX_DOCUMENT_BYTES", str(200_000)))


# ---------------------------------------------------------------------------
# Content-Security-Policy (see core.middleware.ContentSecurityPolicyMiddleware)
# ---------------------------------------------------------------------------
CSP_ENABLED = os.environ.get("CSP_ENABLED", "True").lower() in (
    "1",
    "true",
    "yes",
    "on",
)


# ---------------------------------------------------------------------------
# Production security (active when DEBUG is False)
# ---------------------------------------------------------------------------
if not DEBUG:
    SECURE_SSL_REDIRECT = os.environ.get("SECURE_SSL_REDIRECT", "True").lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SESSION_COOKIE_HTTPONLY = True
    CSRF_COOKIE_HTTPONLY = False  # JS needs CSRF for fetch in editor
    SESSION_COOKIE_SAMESITE = "Lax"
    CSRF_COOKIE_SAMESITE = "Lax"
    SECURE_HSTS_SECONDS = int(os.environ.get("SECURE_HSTS_SECONDS", "31536000"))
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = os.environ.get("SECURE_HSTS_PRELOAD", "False").lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = "same-origin"
    X_FRAME_OPTIONS = "DENY"
    # Do not leak session id over non-HTTPS referrers
    SESSION_COOKIE_NAME = "opentd_sessionid"
    CSRF_COOKIE_NAME = "opentd_csrftoken"
else:
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    CSRF_COOKIE_SAMESITE = "Lax"
    X_FRAME_OPTIONS = "DENY"
    SECURE_CONTENT_TYPE_NOSNIFF = True


# Pending draft retention (days) — used by cleanup_pending_games
PENDING_GAME_RETENTION_DAYS = int(os.environ.get("PENDING_GAME_RETENTION_DAYS", "14"))
