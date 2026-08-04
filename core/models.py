from django.conf import settings
from django.db import models
from django.utils import timezone

from .game_schema import default_game_document


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Game(TimeStampedModel):
    """A tower-defense game owned by a verified account."""

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="games",
    )
    title = models.CharField(max_length=120, default="Untitled game")
    # Full editor document: settings, grid, towers, monsters.
    definition = models.JSONField(default=default_game_document)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self) -> str:
        return f"{self.title} ({self.owner_id})"

    def save(self, *args, **kwargs):
        if isinstance(self.definition, dict):
            title = self.definition.get("title")
            if isinstance(title, str) and title.strip():
                self.title = title.strip()[:120]
        super().save(*args, **kwargs)


class PendingGame(TimeStampedModel):
    """
    Temporary game work for guests and pre-verification signups.

    Lifecycle:
      1. Guest edits → stored under session_key (user=null).
      2. User signs up → user FK set (still pending email verify).
      3. Email confirmed → promoted to Game, this row deleted.
    """

    session_key = models.CharField(max_length=40, db_index=True, blank=True, default="")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="pending_games",
    )
    title = models.CharField(max_length=120, default="Untitled game")
    definition = models.JSONField(default=default_game_document)
    # True once the draft was deliberately stashed around signup.
    locked_for_signup = models.BooleanField(default=False)

    class Meta:
        ordering = ["-updated_at"]
        verbose_name = "pending game"
        verbose_name_plural = "pending games"

    def __str__(self) -> str:
        who = self.user_id or self.session_key or "?"
        return f"Pending: {self.title} ({who})"

    def save(self, *args, **kwargs):
        if isinstance(self.definition, dict):
            title = self.definition.get("title")
            if isinstance(title, str) and title.strip():
                self.title = title.strip()[:120]
        super().save(*args, **kwargs)
