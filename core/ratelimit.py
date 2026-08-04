"""
IP + session rate limiting (database-backed for multi-worker safety).

Windows are fixed-period counters keyed by (bucket, identity).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone


@dataclass(frozen=True)
class RateSpec:
    """limit hits per period_seconds."""

    limit: int
    period_seconds: int
    name: str


# Restrictive defaults for an early public beta
RATE_DRAFT_SAVE = RateSpec(limit=20, period_seconds=60, name="draft_save")
RATE_DRAFT_GET = RateSpec(limit=60, period_seconds=60, name="draft_get")
RATE_SIGNUP = RateSpec(limit=5, period_seconds=3600, name="signup")
RATE_PASSWORD_RESET = RateSpec(limit=5, period_seconds=3600, name="password_reset")
RATE_LOGIN = RateSpec(limit=20, period_seconds=900, name="login")
RATE_STASH_SIGNUP = RateSpec(limit=10, period_seconds=3600, name="stash_signup")
RATE_GAME_SAVE = RateSpec(limit=30, period_seconds=60, name="game_save")
RATE_GAME_CREATE = RateSpec(limit=5, period_seconds=3600, name="game_create")


def client_ip(request: HttpRequest) -> str:
    """Best-effort client IP behind Coolify / reverse proxy."""
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        # First hop is the original client when proxy is trusted.
        return xff.split(",")[0].strip()[:64] or "unknown"
    return (request.META.get("REMOTE_ADDR") or "unknown")[:64]


def session_id(request: HttpRequest) -> str:
    key = getattr(request.session, "session_key", None) or ""
    if not key:
        # Ensure a session exists for guests so we can key limits.
        try:
            if not request.session.session_key:
                request.session.create()
            key = request.session.session_key or ""
        except Exception:
            key = ""
    return key[:64] or "nosession"


def _bucket_key(spec: RateSpec, identity: str) -> str:
    raw = f"{spec.name}:{identity}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:48]


def check_and_hit(request: HttpRequest, spec: RateSpec) -> tuple[bool, int]:
    """
    Record one hit against both IP and session buckets.
    Returns (allowed, retry_after_seconds). Fails closed only on true over-limit.
    """
    from .models import RateLimitBucket

    now = timezone.now()
    identities = [
        f"ip:{client_ip(request)}",
        f"sess:{session_id(request)}",
    ]
    retry_after = 0
    for identity in identities:
        key = _bucket_key(spec, identity)
        with transaction.atomic():
            bucket, _created = (
                RateLimitBucket.objects.select_for_update()
                .get_or_create(
                    key=key,
                    defaults={
                        "count": 0,
                        "window_start": now,
                        "period_seconds": spec.period_seconds,
                    },
                )
            )
            elapsed = (now - bucket.window_start).total_seconds()
            if elapsed >= spec.period_seconds:
                bucket.count = 0
                bucket.window_start = now
                bucket.period_seconds = spec.period_seconds

            if bucket.count >= spec.limit:
                remaining = max(
                    1, int(spec.period_seconds - (now - bucket.window_start).total_seconds())
                )
                retry_after = max(retry_after, remaining)
                return False, retry_after

            bucket.count += 1
            bucket.save(update_fields=["count", "window_start", "period_seconds"])

    return True, 0


def rate_limit_response(retry_after: int):
    from django.http import JsonResponse

    resp = JsonResponse(
        {
            "ok": False,
            "error": "Rate limit exceeded. Please wait and try again.",
            "retry_after": retry_after,
        },
        status=429,
    )
    resp["Retry-After"] = str(max(1, retry_after))
    return resp


def purge_old_buckets(*, older_than_seconds: int = 86400) -> int:
    """Delete rate-limit rows older than one day (or custom)."""
    from datetime import timedelta

    from .models import RateLimitBucket

    cutoff = timezone.now() - timedelta(seconds=older_than_seconds)
    deleted, _ = RateLimitBucket.objects.filter(window_start__lt=cutoff).delete()
    return deleted
