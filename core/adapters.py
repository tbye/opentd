"""django-allauth adapter: closed-beta signup + optional Turnstile."""

from __future__ import annotations

import logging

import re

from allauth.account.adapter import DefaultAccountAdapter
from django.core.exceptions import ValidationError
from django.urls import reverse

from .models import SignupApplication
from .ratelimit import RATE_PASSWORD_RESET, RATE_SIGNUP, check_and_hit, client_ip
from .turnstile import turnstile_enabled, verify_turnstile

logger = logging.getLogger(__name__)

# Public-facing usernames: letters, digits, underscore, hyphen (no email-like forms).
USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{2,29}$")


class AccountAdapter(DefaultAccountAdapter):
    """
    Closed beta: accounts are created on signup, but the verification email
    is held until staff approves the SignupApplication.

    Username is required for public credit (never show email to other players).
    """

    def is_open_for_signup(self, request):
        return True

    def clean_email(self, email):
        email = super().clean_email(email)
        return email

    def clean_username(self, username, shallow=False):
        username = (username or "").strip()
        if not USERNAME_RE.match(username):
            raise ValidationError(
                "Username must be 3–30 characters, start with a letter, and use "
                "only letters, numbers, underscores, or hyphens."
            )
        if "@" in username:
            raise ValidationError("Username cannot look like an email address.")
        return super().clean_username(username, shallow=shallow)

    def send_confirmation_mail(self, request, emailconfirmation, signup):
        """Only send verification mail after closed-beta approval."""
        user = emailconfirmation.email_address.user
        app = SignupApplication.objects.filter(user=user).first()
        if app is not None and app.status != SignupApplication.Status.APPROVED:
            logger.info(
                "Skipping verification email for user %s (beta status=%s)",
                user.pk,
                app.status,
            )
            return
        # Guard against misconfigured empty DEFAULT_FROM_EMAIL in production.
        from django.conf import settings

        from_email = (getattr(settings, "DEFAULT_FROM_EMAIL", None) or "").strip()
        if not from_email or "@" not in from_email:
            logger.error(
                "DEFAULT_FROM_EMAIL is missing or invalid (%r); "
                "cannot send verification mail for user %s",
                from_email,
                user.pk,
            )
            return
        return super().send_confirmation_mail(request, emailconfirmation, signup)

    def get_signup_redirect_url(self, request):
        return reverse("beta_pending")

    def save_user(self, request, user, form, commit=True):
        user = super().save_user(request, user, form, commit=commit)
        if commit:
            SignupApplication.objects.get_or_create(
                user=user,
                defaults={
                    "email": user.email or "",
                    "status": SignupApplication.Status.PENDING,
                    "closed_beta": True,
                },
            )
        return user

    def validate_unique_email(self, email):
        return super().validate_unique_email(email)


def validate_signup_request(request) -> None:
    """Rate limit + Turnstile checks for signup POST (called from form/view)."""
    allowed, retry = check_and_hit(request, RATE_SIGNUP)
    if not allowed:
        raise ValidationError(
            f"Too many signup attempts. Try again in about {retry} seconds."
        )

    if turnstile_enabled():
        token = request.POST.get("cf-turnstile-response", "")
        ok, err = verify_turnstile(token, client_ip(request))
        if not ok:
            raise ValidationError(err or "Captcha failed.")


def validate_password_reset_request(request) -> None:
    allowed, retry = check_and_hit(request, RATE_PASSWORD_RESET)
    if not allowed:
        raise ValidationError(
            f"Too many password reset attempts. Try again in about {retry} seconds."
        )
