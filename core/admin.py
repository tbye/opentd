from django.contrib import admin

from .models import Game, PendingGame


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
