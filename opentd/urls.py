"""
URL configuration for opentd project.
"""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

from core.auth_views import RequestAwarePasswordResetView, RequestAwareSignupView

urlpatterns = [
    path("admin/", admin.site.urls),
    # Custom allauth views (inject request for rate limit + Turnstile)
    path("accounts/signup/", RequestAwareSignupView.as_view(), name="account_signup"),
    path(
        "accounts/password/reset/",
        RequestAwarePasswordResetView.as_view(),
        name="account_reset_password",
    ),
    path("accounts/", include("allauth.urls")),
    path("", include("core.urls")),
]

# Dev server: serve collected static + user media.
# django.contrib.staticfiles also serves STATICFILES_DIRS when DEBUG=True.
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
