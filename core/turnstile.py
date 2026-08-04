"""Cloudflare Turnstile verification for signup."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings


def turnstile_enabled() -> bool:
    return bool(
        getattr(settings, "TURNSTILE_SITE_KEY", "")
        and getattr(settings, "TURNSTILE_SECRET_KEY", "")
    )


def verify_turnstile(token: str, remote_ip: str = "") -> tuple[bool, str]:
    """
    Verify a Turnstile response token with Cloudflare.
    Returns (ok, error_message).
    """
    if not turnstile_enabled():
        # Not configured — treat as pass (closed beta still gates accounts).
        return True, ""

    token = (token or "").strip()
    if not token:
        return False, "Please complete the captcha."

    data = {
        "secret": settings.TURNSTILE_SECRET_KEY,
        "response": token,
    }
    if remote_ip:
        data["remoteip"] = remote_ip

    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return False, "Captcha verification failed. Try again."

    if payload.get("success"):
        return True, ""
    return False, "Captcha verification failed. Try again."
