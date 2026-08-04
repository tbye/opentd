from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.urls import reverse
from django.utils.html import format_html

from .models import (
    Game,
    PendingGame,
    RateLimitBucket,
    SignupApplication,
    UserProfile,
)

User = get_user_model()


class UserProfileInline(admin.StackedInline):
    model = UserProfile
    can_delete = False
    fk_name = "user"
    extra = 0
    fields = ("max_games", "created_at", "updated_at")
    readonly_fields = ("created_at", "updated_at")


# Re-register User with profile inline so staff can set max_games per account.
try:
    admin.site.unregister(User)
except admin.sites.NotRegistered:
    pass


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    inlines = (UserProfileInline,)
    list_display = DjangoUserAdmin.list_display + ("profile_max_games",)

    @admin.display(description="Max games")
    def profile_max_games(self, obj):
        profile = getattr(obj, "profile", None)
        if profile is None:
            return "—"
        return profile.max_games


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "max_games", "updated_at", "created_at")
    list_editable = ("max_games",)
    search_fields = ("user__email", "user__username")
    raw_id_fields = ("user",)
    readonly_fields = ("created_at", "updated_at")


@admin.register(Game)
class GameAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "owner",
        "is_public",
        "allow_download",
        "share_code",
        "updated_at",
    )
    list_filter = ("is_public", "allow_download", "updated_at")
    search_fields = ("title", "share_code", "owner__email", "owner__username")
    raw_id_fields = ("owner",)
    readonly_fields = ("created_at", "updated_at", "share_code")


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
