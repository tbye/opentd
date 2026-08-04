from django.conf import settings


def site_settings(request):
    return {
        "site_name": getattr(settings, "SITE_NAME", "OpenTD"),
        "site_domain": getattr(settings, "SITE_DOMAIN", "localhost:8000"),
    }
