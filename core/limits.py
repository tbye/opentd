"""Platform limits by account tier (guest vs registered) and per-user prefs."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from django.http import HttpRequest

# Default max games for new registered accounts (overridable per user in admin).
DEFAULT_REGISTERED_MAX_GAMES = 5


@dataclass(frozen=True)
class TierLimits:
    """Caps for one editor session / account tier."""

    max_games: int
    max_towers: int
    max_monsters: int
    max_wave_types: int
    # Human label for UI
    tier: str  # "guest" | "registered"


# Guests / free anonymous editors
GUEST_LIMITS = TierLimits(
    max_games=1,
    max_towers=5,
    max_monsters=5,
    max_wave_types=3,
    tier="guest",
)

# Registered (verified) accounts — type budgets; max_games comes from UserProfile
REGISTERED_LIMITS = TierLimits(
    max_games=DEFAULT_REGISTERED_MAX_GAMES,
    max_towers=20,
    max_monsters=20,
    max_wave_types=10,
    tier="registered",
)

# Hard document budget (serialized JSON) — keep playtest/editor snappy
MAX_DOCUMENT_BYTES = 200_000  # ~200 KiB after normalize
MAX_REQUEST_BODY_BYTES = 262_144  # 256 KiB raw body

# Portal / map density: special cells cannot exceed grid area (enforced in schema)
# String field budgets (sanitized plain text)
MAX_TITLE_LEN = 80
MAX_NAME_LEN = 40
MAX_DESCRIPTION_LEN = 200
MAX_ID_LEN = 24


def get_or_create_profile(user):
    """Return UserProfile for user, creating with defaults if missing."""
    from .models import UserProfile

    profile, _ = UserProfile.objects.get_or_create(
        user=user,
        defaults={"max_games": DEFAULT_REGISTERED_MAX_GAMES},
    )
    return profile


def max_games_for_user(user) -> int:
    """Per-user game cap (registered accounts)."""
    if user is None or not getattr(user, "is_authenticated", False):
        return GUEST_LIMITS.max_games
    profile = get_or_create_profile(user)
    return max(1, int(profile.max_games or DEFAULT_REGISTERED_MAX_GAMES))


def limits_for_request(request: HttpRequest | None) -> TierLimits:
    if request is not None and getattr(request, "user", None) is not None:
        if request.user.is_authenticated:
            return TierLimits(
                max_games=max_games_for_user(request.user),
                max_towers=REGISTERED_LIMITS.max_towers,
                max_monsters=REGISTERED_LIMITS.max_monsters,
                max_wave_types=REGISTERED_LIMITS.max_wave_types,
                tier="registered",
            )
    return GUEST_LIMITS


def limits_to_dict(limits: TierLimits) -> dict[str, Any]:
    return asdict(limits)
