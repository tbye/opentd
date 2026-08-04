"""Auth forms with rate limits + Cloudflare Turnstile."""

from __future__ import annotations

from allauth.account.forms import ResetPasswordForm, SignupForm
from django import forms
from django.conf import settings

from .adapters import validate_password_reset_request, validate_signup_request
from .turnstile import turnstile_enabled


class ClosedBetaSignupForm(SignupForm):
    """Signup form for the closed beta (Turnstile + rate limits)."""

    def __init__(self, *args, **kwargs):
        self.request = kwargs.pop("request", None)
        super().__init__(*args, **kwargs)

    def clean(self):
        cleaned = super().clean()
        request = getattr(self, "request", None)
        if request is not None:
            from django.core.exceptions import ValidationError as DjangoValidationError

            try:
                validate_signup_request(request)
            except (forms.ValidationError, DjangoValidationError) as exc:
                msgs = getattr(exc, "messages", None) or [str(exc)]
                raise forms.ValidationError(list(msgs))
        return cleaned


class RateLimitedResetPasswordForm(ResetPasswordForm):
    def __init__(self, *args, **kwargs):
        self.request = kwargs.pop("request", None)
        super().__init__(*args, **kwargs)

    def clean(self):
        cleaned = super().clean()
        request = getattr(self, "request", None)
        if request is not None:
            from django.core.exceptions import ValidationError as DjangoValidationError

            try:
                validate_password_reset_request(request)
            except (forms.ValidationError, DjangoValidationError) as exc:
                msgs = getattr(exc, "messages", None) or [str(exc)]
                raise forms.ValidationError(list(msgs))
        return cleaned


def turnstile_context() -> dict:
    enabled = turnstile_enabled()
    return {
        "turnstile_enabled": enabled,
        "turnstile_site_key": getattr(settings, "TURNSTILE_SITE_KEY", "") or "",
        "turnstile_required": enabled,
    }
