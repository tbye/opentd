from pathlib import Path

from django.conf import settings

from .forms import turnstile_context

# Browsers and Cloudflare cache /static/js/editor.js for hours. The editor
# HTML is not cached the same way, so a new picker can ship while the old
# script — which does not handle those clicks — stays in cache. Tie the
# asset URL to the newest source mtime so each deploy requests a fresh file.
_ASSET_PATHS = (
    "js/editor.js",
    "js/playtest.js",
    "js/design_validate.js",
    "js/htmx.min.js",
    "css/output.css",
)


def static_asset_version() -> str:
    root = Path(settings.BASE_DIR) / "static"
    newest = 0
    for rel in _ASSET_PATHS:
        try:
            newest = max(newest, int((root / rel).stat().st_mtime))
        except OSError:
            continue
    return str(newest or 1)


def site_settings(request):
    ctx = {
        "site_name": getattr(settings, "SITE_NAME", "OpenTD.org"),
        "site_domain": getattr(settings, "SITE_DOMAIN", "opentd.org"),
        "static_asset_version": static_asset_version(),
    }
    ctx.update(turnstile_context())
    return ctx
