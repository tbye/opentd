from __future__ import annotations

import json

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .drafts import (
    get_pending_for_request,
    load_editor_document,
    save_draft,
)
from .game_schema import normalize_game_document
from .models import Game


def home(request: HttpRequest) -> HttpResponse:
    games = []
    if request.user.is_authenticated:
        games = list(Game.objects.filter(owner=request.user)[:12])
    return render(request, "home.html", {"games": games})


@require_GET
def editor(request: HttpRequest) -> HttpResponse:
    """
    Guest-friendly game editor.

    Authenticated users may open ?game=<id> for a saved game (read into the
    client; autosave of owned games is separate from the pending-draft path).
    """
    game_id = request.GET.get("game")
    owned_game = None
    parsed_id = None
    if game_id and request.user.is_authenticated:
        try:
            parsed_id = int(game_id)
            owned_game = Game.objects.filter(pk=parsed_id, owner=request.user).first()
        except (TypeError, ValueError):
            parsed_id = None

    document = load_editor_document(
        request, game_id=parsed_id if owned_game else None
    )
    pending = get_pending_for_request(request)

    return render(
        request,
        "editor.html",
        {
            "game_document": document,
            "game_document_json": json.dumps(document),
            "owned_game": owned_game,
            "pending_game": pending,
            "is_guest": not request.user.is_authenticated,
        },
    )


def _parse_json_body(request: HttpRequest) -> dict:
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid JSON body.") from exc
    if not isinstance(payload, dict):
        raise ValueError("JSON body must be an object.")
    return payload


@require_http_methods(["GET", "POST"])
def draft_api(request: HttpRequest) -> JsonResponse:
    """Load or save the guest / pre-verify draft for this session."""
    if request.method == "GET":
        pending = get_pending_for_request(request)
        if pending is None:
            doc = load_editor_document(request)
            return JsonResponse({"ok": True, "definition": doc, "pending_id": None})
        return JsonResponse(
            {
                "ok": True,
                "definition": normalize_game_document(pending.definition),
                "pending_id": pending.pk,
                "locked_for_signup": pending.locked_for_signup,
            }
        )

    try:
        payload = _parse_json_body(request)
        definition = payload.get("definition", payload)
        lock = bool(payload.get("lock_for_signup", False))
        pending = save_draft(request, definition, lock_for_signup=lock)
    except ValueError as exc:
        return JsonResponse({"ok": False, "error": str(exc)}, status=400)

    return JsonResponse(
        {
            "ok": True,
            "pending_id": pending.pk,
            "title": pending.title,
            "locked_for_signup": pending.locked_for_signup,
        }
    )


@require_POST
def stash_and_signup(request: HttpRequest) -> HttpResponse:
    """
    Persist current draft (JSON body or form field), mark for signup, redirect.

    Used by the editor “Sign up to save” action so work survives verification.
    """
    definition = None
    if request.content_type and "application/json" in request.content_type:
        try:
            payload = _parse_json_body(request)
            definition = payload.get("definition", payload)
        except ValueError as exc:
            return JsonResponse({"ok": False, "error": str(exc)}, status=400)
    else:
        raw = request.POST.get("definition")
        if raw:
            try:
                definition = json.loads(raw)
            except json.JSONDecodeError:
                messages.error(request, "Could not read your game draft.")
                return redirect("editor")

    if definition is not None:
        try:
            save_draft(request, definition, lock_for_signup=True)
        except ValueError:
            messages.error(request, "Could not save your game draft.")
            return redirect("editor")

    if request.headers.get("HX-Request") or (
        request.content_type and "application/json" in request.content_type
    ):
        return JsonResponse({"ok": True, "redirect": "/accounts/signup/"})
    return redirect("account_signup")


@require_POST
@login_required
def save_owned_game(request: HttpRequest, game_id: int) -> JsonResponse:
    """Update an already-owned game (post-verification)."""
    game = get_object_or_404(Game, pk=game_id, owner=request.user)
    try:
        payload = _parse_json_body(request)
        definition = normalize_game_document(payload.get("definition", payload))
    except ValueError as exc:
        return JsonResponse({"ok": False, "error": str(exc)}, status=400)
    game.definition = definition
    game.title = definition.get("title") or game.title
    game.save()
    return JsonResponse({"ok": True, "game_id": game.pk, "title": game.title})


@require_POST
@login_required
def create_game_from_editor(request: HttpRequest) -> JsonResponse:
    """Authenticated user explicitly saves editor state as a new Game."""
    try:
        payload = _parse_json_body(request)
        definition = normalize_game_document(payload.get("definition", payload))
    except ValueError as exc:
        return JsonResponse({"ok": False, "error": str(exc)}, status=400)
    game = Game.objects.create(
        owner=request.user,
        title=definition.get("title") or "Untitled game",
        definition=definition,
    )
    return JsonResponse({"ok": True, "game_id": game.pk, "title": game.title})
