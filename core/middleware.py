"""Security middleware: body size guard + Content-Security-Policy."""

from __future__ import annotations

from django.conf import settings
from django.http import HttpRequest, HttpResponse, JsonResponse


class RequestBodySizeMiddleware:
    """Reject oversized request bodies early (before JSON parse)."""

    def __init__(self, get_response):
        self.get_response = get_response
        self.max_bytes = int(
            getattr(settings, "MAX_REQUEST_BODY_BYTES", 262_144)
        )

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if request.method in ("POST", "PUT", "PATCH"):
            length = request.META.get("CONTENT_LENGTH")
            try:
                n = int(length) if length else 0
            except (TypeError, ValueError):
                n = 0
            if n > self.max_bytes:
                if "application/json" in (request.content_type or ""):
                    return JsonResponse(
                        {
                            "ok": False,
                            "error": f"Request body too large (max {self.max_bytes} bytes).",
                        },
                        status=413,
                    )
                return HttpResponse(
                    f"Request body too large (max {self.max_bytes} bytes).",
                    status=413,
                    content_type="text/plain",
                )
        return self.get_response(request)


class ContentSecurityPolicyMiddleware:
    """
    Reasonable CSP for OpenTD.

    - Scripts: self + Cloudflare Turnstile when captcha is enabled
    - Styles: self + Google Fonts CSS
    - Fonts: self + Google Fonts
    - Connect: self + Turnstile verify is server-side only
    - Frame: Turnstile needs challenges.cloudflare.com
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        if getattr(settings, "CSP_ENABLED", True):
            response["Content-Security-Policy"] = self._policy()
        return response

    def _policy(self) -> str:
        turnstile = bool(getattr(settings, "TURNSTILE_SITE_KEY", ""))
        script_src = ["'self'"]
        # Inline hx-headers / small boot scripts in base templates
        script_src.append("'unsafe-inline'")
        if turnstile:
            script_src.append("https://challenges.cloudflare.com")

        style_src = ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]
        font_src = ["'self'", "https://fonts.gstatic.com", "data:"]
        img_src = ["'self'", "data:", "blob:"]
        connect_src = ["'self'"]
        frame_src = ["'none'"]
        if turnstile:
            frame_src = ["https://challenges.cloudflare.com"]

        parts = [
            "default-src 'self'",
            f"script-src {' '.join(script_src)}",
            f"style-src {' '.join(style_src)}",
            f"font-src {' '.join(font_src)}",
            f"img-src {' '.join(img_src)}",
            f"connect-src {' '.join(connect_src)}",
            f"frame-src {' '.join(frame_src)}",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
        if not settings.DEBUG:
            parts.append("upgrade-insecure-requests")
        return "; ".join(parts)
