from django.contrib import admin
from django.urls import reverse
from django.utils.html import format_html

from .models import Game, PendingGame, RateLimitBucket, SignupApplication


@admin.register(Game)
class GameAdmin(admin.ModelAdmin):
    list_display = ("title", "owner", "updated_at", "created_at")
    list_filter = ("updated_at",)
    search_fields = ("title", "owner__email", "owner__username")
    raw_id_fields = ("owner",)
    readonly_fields = ("created_at", "updated_at")


@admin.register(PendingGame)
class PendingGameAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "user",
        "session_key",
        "locked_for_signup",
        "updated_at",
    )
    list_filter = ("locked_for_signup", "updated_at")
    search_fields = ("title", "session_key", "user__email")
    raw_id_fields = ("user",)
    readonly_fields = ("created_at", "updated_at")


@admin.register(SignupApplication)
class SignupApplicationAdmin(admin.ModelAdmin):
    list_display = (
        "email",
        "status",
        "closed_beta",
        "created_at",
        "reviewed_at",
        "moderation_link",
    )
    list_filter = ("status", "closed_beta", "created_at")
    search_fields = ("email", "user__email", "notes")
    raw_id_fields = ("user", "reviewed_by")
    readonly_fields = ("created_at", "updated_at", "reviewed_at")

    @admin.display(description="Queue")
    def moderation_link(self, obj):
        url = reverse("beta_moderation")
        return format_html('<a href="{}">Open beta queue</a>', url)


@admin.register(RateLimitBucket)
class RateLimitBucketAdmin(admin.ModelAdmin):
    list_display = ("key", "count", "window_start", "period_seconds")
    search_fields = ("key",)
    readonly_fields = ("key", "count", "window_start", "period_seconds")
