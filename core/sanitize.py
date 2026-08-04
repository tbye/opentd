"""Sanitize user-authored strings for safe storage and display."""

from __future__ import annotations

import re
from html import unescape

from django.utils.html import strip_tags

from .limits import MAX_DESCRIPTION_LEN, MAX_ID_LEN, MAX_NAME_LEN, MAX_TITLE_LEN

# After sanitize, IDs are safe for use in attributes / paths (no HTML).
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_plain_text(value: object, *, max_len: int) -> str:
    """Strip HTML/tags/control chars; collapse whitespace; truncate."""
    text = unescape(str(value if value is not None else ""))
    text = strip_tags(text)
    text = _CONTROL_RE.sub("", text)
    text = " ".join(text.split())
    return text[:max_len]


def clean_title(value: object) -> str:
    t = clean_plain_text(value, max_len=MAX_TITLE_LEN)
    return t or "Untitled game"


def clean_name(value: object, *, default: str = "Unnamed") -> str:
    t = clean_plain_text(value, max_len=MAX_NAME_LEN)
    return t or default


def clean_description(value: object) -> str:
    """Descriptions are plain text only — never store HTML."""
    return clean_plain_text(value, max_len=MAX_DESCRIPTION_LEN)


def clean_id(value: object, *, fallback: str = "1") -> str:
    """Restrict entity/portal ids to a safe charset and length.

    Empty string is allowed when fallback is '' (e.g. optional upgrade_of).
    """
    text = str(value if value is not None else "").strip()
    text = _CONTROL_RE.sub("", text)[:MAX_ID_LEN]
    if text == "" and fallback == "":
        return ""
    if SAFE_ID_RE.fullmatch(text):
        return text
    # Strip invalid chars
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "", text)[:MAX_ID_LEN]
    if cleaned and SAFE_ID_RE.fullmatch(cleaned):
        return cleaned
    if fallback == "":
        return ""
    fb = re.sub(r"[^A-Za-z0-9_-]", "", str(fallback))[:MAX_ID_LEN]
    return fb if fb else "1"
