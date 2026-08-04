"""Platform limits by account tier (guest vs registered)."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from django.http import HttpRequest


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

# Registered (verified) accounts — still one game for now; higher type budgets
REGISTERED_LIMITS = TierLimits(
    max_games=1,
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


def limits_for_request(request: HttpRequest | None) -> TierLimits:
    if request is not None and getattr(request, "user", None) is not None:
        if request.user.is_authenticated:
            return REGISTERED_LIMITS
    return GUEST_LIMITS


def limits_to_dict(limits: TierLimits) -> dict[str, Any]:
    return asdict(limits)
