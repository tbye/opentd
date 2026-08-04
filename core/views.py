from __future__ import annotations

import json

from allauth.account.models import EmailAddress
from django.contrib import messages
from django.contrib.admin.views.decorators import staff_member_required
from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .drafts import (
    get_pending_for_request,
    load_editor_document,
    save_draft,
)
from .forms import turnstile_context
from .game_schema import normalize_game_document
from .limits import (
    MAX_DOCUMENT_BYTES,
    MAX_REQUEST_BODY_BYTES,
    limits_for_request,
    limits_to_dict,
)
from .models import Game, SignupApplication
from .ratelimit import (
    RATE_DRAFT_GET,
    RATE_DRAFT_SAVE,
    RATE_GAME_CREATE,
    RATE_GAME_SAVE,
    RATE_STASH_SIGNUP,
    check_and_hit,
    rate_limit_response,
)


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
    limits = limits_for_request(request)

    return render(
        request,
        "editor.html",
        {
            "game_document": document,
            "game_document_json": json.dumps(document),
            "owned_game": owned_game,
            "pending_game": pending,
            "is_guest": not request.user.is_authenticated,
            "editor_limits": limits_to_dict(limits),
            "editor_limits_json": json.dumps(limits_to_dict(limits)),
            "max_document_bytes": MAX_DOCUMENT_BYTES,
        },
    )


def _parse_json_body(request: HttpRequest) -> dict:
    raw = request.body or b""
    if len(raw) > MAX_REQUEST_BODY_BYTES:
        raise ValueError(
            f"Request body too large (max {MAX_REQUEST_BODY_BYTES} bytes)."
        )
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid JSON body.") from exc
    if not isinstance(payload, dict):
        raise ValueError("JSON body must be an object.")
    return payload


@require_http_methods(["GET", "POST"])
def draft_api(request: HttpRequest) -> JsonResponse:
    """Load or save the guest / pre-verify draft for this session."""
    if request.method == "GET":
        allowed, retry = check_and_hit(request, RATE_DRAFT_GET)
        if not allowed:
            return rate_limit_response(retry)
        pending = get_pending_for_request(request)
        limits = limits_for_request(request)
        if pending is None:
            doc = load_editor_document(request)
            return JsonResponse(
                {
                    "ok": True,
                    "definition": doc,
                    "pending_id": None,
                    "limits": limits_to_dict(limits),
                }
            )
        return JsonResponse(
            {
                "ok": True,
                "definition": normalize_game_document(
                    pending.definition, limits=limits
                ),
                "pending_id": pending.pk,
                "locked_for_signup": pending.locked_for_signup,
                "limits": limits_to_dict(limits),
            }
        )

    allowed, retry = check_and_hit(request, RATE_DRAFT_SAVE)
    if not allowed:
        return rate_limit_response(retry)

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
            "limits": limits_to_dict(limits_for_request(request)),
        }
    )


@require_POST
def stash_and_signup(request: HttpRequest) -> HttpResponse:
    """
    Persist current draft (JSON body or form field), mark for signup, redirect.

    Used by the editor “Sign up to save” action so work survives verification.
    """
    allowed, retry = check_and_hit(request, RATE_STASH_SIGNUP)
    if not allowed:
        if request.content_type and "application/json" in request.content_type:
            return rate_limit_response(retry)
        messages.error(request, "Too many attempts. Please wait and try again.")
        return redirect("editor")

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
            if len(raw.encode("utf-8")) > MAX_REQUEST_BODY_BYTES:
                messages.error(request, "Draft is too large to save.")
                return redirect("editor")
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
    allowed, retry = check_and_hit(request, RATE_GAME_SAVE)
    if not allowed:
        return rate_limit_response(retry)

    game = get_object_or_404(Game, pk=game_id, owner=request.user)
    try:
        payload = _parse_json_body(request)
        definition = normalize_game_document(
            payload.get("definition", payload),
            limits=limits_for_request(request),
        )
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
    allowed, retry = check_and_hit(request, RATE_GAME_CREATE)
    if not allowed:
        return rate_limit_response(retry)

    limits = limits_for_request(request)
    owned = Game.objects.filter(owner=request.user).count()
    if owned >= limits.max_games:
        return JsonResponse(
            {
                "ok": False,
                "error": f"You can only have {limits.max_games} game on this account.",
            },
            status=400,
        )

    try:
        payload = _parse_json_body(request)
        definition = normalize_game_document(
            payload.get("definition", payload), limits=limits
        )
    except ValueError as exc:
        return JsonResponse({"ok": False, "error": str(exc)}, status=400)
    game = Game.objects.create(
        owner=request.user,
        title=definition.get("title") or "Untitled game",
        definition=definition,
    )
    return JsonResponse({"ok": True, "game_id": game.pk, "title": game.title})


@require_GET
def beta_pending(request: HttpRequest) -> HttpResponse:
    """Shown after signup while closed-beta review is pending."""
    return render(
        request,
        "account/beta_pending.html",
        turnstile_context(),
    )


@staff_member_required
@require_GET
def beta_moderation_list(request: HttpRequest) -> HttpResponse:
    """Staff list of pending closed-beta registrations."""
    apps = (
        SignupApplication.objects.filter(status=SignupApplication.Status.PENDING)
        .select_related("user")
        .order_by("created_at")
    )
    return render(
        request,
        "staff/beta_moderation.html",
        {"applications": apps},
    )


@staff_member_required
@require_POST
def beta_moderation_action(request: HttpRequest, app_id: int) -> HttpResponse:
    """Approve (send verification email) or reject a signup application."""
    app = get_object_or_404(SignupApplication, pk=app_id)
    action = (request.POST.get("action") or "").strip()
    notes = (request.POST.get("notes") or "").strip()[:4000]
    if notes:
        app.notes = notes

    if action == "reject":
        app.status = SignupApplication.Status.REJECTED
        app.reviewed_at = timezone.now()
        app.reviewed_by = request.user
        app.save()
        # Keep the user record but prevent login via is_active
        user = app.user
        user.is_active = False
        user.save(update_fields=["is_active"])
        messages.success(request, f"Rejected {app.email} (hidden from queue).")
        return redirect("beta_moderation")

    if action == "approve":
        app.status = SignupApplication.Status.APPROVED
        app.reviewed_at = timezone.now()
        app.reviewed_by = request.user
        app.save()
        user = app.user
        if not user.is_active:
            user.is_active = True
            user.save(update_fields=["is_active"])
        # Ensure EmailAddress exists and send verification
        email_addr, _ = EmailAddress.objects.get_or_create(
            user=user,
            email=user.email,
            defaults={"primary": True, "verified": False},
        )
        try:
            # Status is APPROVED so adapter.send_confirmation_mail will send.
            email_addr.send_confirmation(request, signup=True)
            messages.success(
                request,
                f"Approved {app.email} — verification email sent.",
            )
        except Exception as exc:  # noqa: BLE001
            messages.warning(
                request,
                f"Approved {app.email}, but email send failed: {exc}",
            )
        return redirect("beta_moderation")

    messages.error(request, "Unknown action.")
    return redirect("beta_moderation")
