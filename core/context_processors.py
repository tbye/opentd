from django.conf import settings

from .forms import turnstile_context


def site_settings(request):
    ctx = {
        "site_name": getattr(settings, "SITE_NAME", "OpenTD"),
        "site_domain": getattr(settings, "SITE_DOMAIN", "localhost:8000"),
    }
    ctx.update(turnstile_context())
    return ctx
