"""Session + DB helpers for guest / pre-verify game drafts."""

from __future__ import annotations

from typing import Any

from django.contrib.auth.models import AbstractBaseUser
from django.http import HttpRequest

from .game_schema import default_game_document, normalize_game_document
from .models import Game, PendingGame

SESSION_DRAFT_ID = "opentd_pending_game_id"


def ensure_session(request: HttpRequest) -> str:
    if not request.session.session_key:
        request.session.create()
    return request.session.session_key or ""


def get_pending_for_request(request: HttpRequest) -> PendingGame | None:
    """Prefer session-linked draft; fall back to the user's latest pending row."""
    pending_id = request.session.get(SESSION_DRAFT_ID)
    if pending_id:
        try:
            return PendingGame.objects.get(pk=pending_id)
        except PendingGame.DoesNotExist:
            request.session.pop(SESSION_DRAFT_ID, None)

    session_key = request.session.session_key
    if session_key:
        pending = (
            PendingGame.objects.filter(session_key=session_key)
            .order_by("-updated_at")
            .first()
        )
        if pending:
            request.session[SESSION_DRAFT_ID] = pending.pk
            return pending

    user = request.user
    if user.is_authenticated:
        pending = (
            PendingGame.objects.filter(user=user).order_by("-updated_at").first()
        )
        if pending:
            request.session[SESSION_DRAFT_ID] = pending.pk
            return pending
    return None


def save_draft(
    request: HttpRequest,
    definition: Any,
    *,
    lock_for_signup: bool = False,
) -> PendingGame:
    """Create or update the pending game for this browser session."""
    doc = normalize_game_document(definition)
    session_key = ensure_session(request)
    pending = get_pending_for_request(request)

    user = request.user if request.user.is_authenticated else None
    if pending is None:
        pending = PendingGame(
            session_key=session_key,
            user=user if user and user.is_authenticated else None,
        )
    else:
        if not pending.session_key:
            pending.session_key = session_key
        if user and user.is_authenticated and pending.user_id is None:
            pending.user = user

    pending.definition = doc
    pending.title = doc.get("title") or pending.title
    if lock_for_signup:
        pending.locked_for_signup = True
    pending.save()
    request.session[SESSION_DRAFT_ID] = pending.pk
    request.session.modified = True
    return pending


def attach_pending_to_user(request: HttpRequest, user: AbstractBaseUser) -> PendingGame | None:
    """Link the session draft to a newly signed-up user (pre-verification)."""
    pending = get_pending_for_request(request)
    if pending is None:
        # Nothing in session — still create an empty pending if they signed up
        # from the marketing page without editing? Skip empty attach.
        return None
    pending.user = user  # type: ignore[assignment]
    pending.locked_for_signup = True
    if not pending.session_key:
        pending.session_key = ensure_session(request)
    pending.save(update_fields=["user", "locked_for_signup", "session_key", "updated_at"])
    request.session[SESSION_DRAFT_ID] = pending.pk
    request.session.modified = True
    return pending


def promote_pending_to_game(user: AbstractBaseUser) -> Game | None:
    """
    After email verification: copy the user's pending draft into a real Game.

    Returns the created Game, or None if there was nothing to promote.
    """
    pending = (
        PendingGame.objects.filter(user=user).order_by("-updated_at").first()
    )
    if pending is None:
        return None

    definition = normalize_game_document(pending.definition)
    game = Game.objects.create(
        owner=user,  # type: ignore[misc]
        title=definition.get("title") or pending.title or "Untitled game",
        definition=definition,
    )
    # Drop all pending rows for this user (and matching session) after promote.
    PendingGame.objects.filter(user=user).delete()
    return game


def load_editor_document(request: HttpRequest, game_id: int | None = None) -> dict[str, Any]:
    """Document to hydrate the editor (owned game or pending draft or blank)."""
    if game_id is not None and request.user.is_authenticated:
        try:
            game = Game.objects.get(pk=game_id, owner=request.user)
            return normalize_game_document(game.definition)
        except Game.DoesNotExist:
            pass

    pending = get_pending_for_request(request)
    if pending is not None:
        return normalize_game_document(pending.definition)

    return default_game_document()
