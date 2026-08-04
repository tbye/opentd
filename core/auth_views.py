"""allauth views that inject request into custom forms."""

from __future__ import annotations

from allauth.account.views import PasswordResetView, SignupView


class RequestAwareSignupView(SignupView):
    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["request"] = self.request
        return kwargs


class RequestAwarePasswordResetView(PasswordResetView):
    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["request"] = self.request
        return kwargs
