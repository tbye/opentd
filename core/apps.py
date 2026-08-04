from django.apps import AppConfig


class CoreConfig(AppConfig):
    name = "core"
    verbose_name = "Core"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        # Register allauth signal handlers.
        from . import signals  # noqa: F401
