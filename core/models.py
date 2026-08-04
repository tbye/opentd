import secrets

from django.conf import settings
from django.db import models
from django.utils import timezone

from .game_schema import GAME_TYPE_LABELS, default_game_document
from .sanitize import clean_title


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class UserProfile(TimeStampedModel):
    """
    Per-user preferences and caps (staff can raise max_games, etc.).
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="profile",
    )
    # How many saved Game rows this account may own.
    max_games = models.PositiveIntegerField(
        default=5,
        help_text="Maximum number of saved games this registered user may own.",
    )

    class Meta:
        verbose_name = "user profile"
        verbose_name_plural = "user profiles"

    def __str__(self) -> str:
        return f"Profile({self.user_id}, max_games={self.max_games})"


def _default_share_code() -> str:
    return secrets.token_urlsafe(9)


class Game(TimeStampedModel):
    """A tower-defense game owned by a verified account."""

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="games",
    )
    title = models.CharField(max_length=80, default="Untitled game")
    # Full editor document: settings, grid, towers, monsters.
    definition = models.JSONField(default=default_game_document)
    # Opaque share id for /play/<code>/ (not sequential).
    share_code = models.CharField(
        max_length=24,
        unique=True,
        db_index=True,
        default=_default_share_code,
        editable=False,
    )
    # Listed in gallery / homepage and open via share URL.
    is_public = models.BooleanField(
        default=False,
        help_text="When on, anyone can play via the share link and it may appear in the gallery.",
    )
    # Allow visitors (and the owner) to download the OpenTD JSON export.
    allow_download = models.BooleanField(
        default=False,
        help_text="When on, anyone may download the game as OpenTD JSON.",
    )

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self) -> str:
        return f"{self.title} ({self.owner_id})"

    @property
    def author_credit(self) -> str:
        """
        Public-facing creator name for player-facing UIs.

        Prefer username so we never dox authors with their email.
        """
        owner = self.owner
        if owner is None:
            return "Unknown designer"
        username = (getattr(owner, "username", None) or "").strip()
        if username and "@" not in username:
            return username
        # Legacy accounts without a real public username
        return "Anonymous designer"

    @property
    def game_type(self) -> str:
        settings = (self.definition or {}).get("settings") or {}
        return str(settings.get("game_type") or "monster_march")

    @property
    def game_type_label(self) -> str:
        return GAME_TYPE_LABELS.get(self.game_type, self.game_type.replace("_", " ").title())

    def save(self, *args, **kwargs):
        if not self.share_code:
            self.share_code = _default_share_code()
        if isinstance(self.definition, dict):
            title = self.definition.get("title")
            if isinstance(title, str) and title.strip():
                self.title = clean_title(title)
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
    title = models.CharField(max_length=80, default="Untitled game")
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
                self.title = clean_title(title)
        super().save(*args, **kwargs)


class SignupApplication(TimeStampedModel):
    """
    Closed-beta registration queue.

    Users can sign up, but verification email is only sent after a staff
    member approves the application. Rejected applications stay in the DB
    but are hidden from the pending list.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending review"
        APPROVED = "approved", "Approved (verification sent)"
        REJECTED = "rejected", "Rejected"

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="signup_application",
    )
    email = models.EmailField(db_index=True)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    # Closed beta flag (always true for now; kept for reporting)
    closed_beta = models.BooleanField(default=True)
    # Moderator notes for approval decisions
    notes = models.TextField(blank=True, default="")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reviewed_signups",
    )

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "signup application"
        verbose_name_plural = "signup applications"

    def __str__(self) -> str:
        return f"{self.email} ({self.status})"


class RateLimitBucket(models.Model):
    """Fixed-window rate limit counter (user, or session/IP for guests)."""

    key = models.CharField(max_length=64, unique=True, db_index=True)
    count = models.PositiveIntegerField(default=0)
    window_start = models.DateTimeField()
    period_seconds = models.PositiveIntegerField(default=60)

    class Meta:
        verbose_name = "rate limit bucket"
        verbose_name_plural = "rate limit buckets"

    def __str__(self) -> str:
        return f"{self.key}={self.count}"
