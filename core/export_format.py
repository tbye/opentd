"""
OpenTD portable game export / import format.

Export shape (JSON):
{
  "format": "opentd.game",
  "format_version": 1,
  "title": "...",
  "exported_at": "2026-08-04T12:00:00Z",  # optional
  "definition": { ... normalized game document ... }
}

The definition object is the same document the editor stores (settings, grid,
towers, monsters, wave_types, spawns, exits, scoreboard).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .game_schema import normalize_game_document
from .limits import TierLimits, limits_for_request
from .sanitize import clean_title

FORMAT_ID = "opentd.game"
FORMAT_VERSION = 1


def build_export_payload(
    *,
    title: str,
    definition: dict[str, Any],
    limits: TierLimits | None = None,
) -> dict[str, Any]:
    """Normalize and wrap a game definition for download."""
    doc = normalize_game_document(definition, limits=limits)
    return {
        "format": FORMAT_ID,
        "format_version": FORMAT_VERSION,
        "title": clean_title(title or doc.get("title") or "Untitled game"),
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "definition": doc,
    }


def parse_import_payload(
    raw: Any,
    *,
    limits: TierLimits | None = None,
) -> tuple[str, dict[str, Any]]:
    """
    Accept either a full export wrapper or a bare definition object.
    Returns (title, definition).
    """
    if not isinstance(raw, dict):
        raise ValueError("Import JSON must be an object.")

    if raw.get("format") == FORMAT_ID or "definition" in raw:
        ver = raw.get("format_version", 1)
        try:
            ver_i = int(ver)
        except (TypeError, ValueError):
            ver_i = 1
        if ver_i > FORMAT_VERSION:
            raise ValueError(
                f"Unsupported format_version {ver_i} (this site supports up to {FORMAT_VERSION})."
            )
        definition_raw = raw.get("definition")
        if not isinstance(definition_raw, dict):
            raise ValueError("Export is missing a definition object.")
        title = clean_title(raw.get("title") or definition_raw.get("title") or "Imported game")
        definition = normalize_game_document(definition_raw, limits=limits)
        return title, definition

    # Bare editor document
    definition = normalize_game_document(raw, limits=limits)
    title = clean_title(definition.get("title") or "Imported game")
    return title, definition
