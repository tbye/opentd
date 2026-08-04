from __future__ import annotations

import json
import random

from allauth.account.models import EmailAddress
from django.contrib import messages
from django.contrib.admin.views.decorators import staff_member_required
from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse, HttpResponseForbidden, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from .drafts import (
    get_pending_for_request,
    load_editor_document,
    save_draft,
)
from .export_format import build_export_payload, parse_import_payload
from .forms import turnstile_context
from .game_schema import GAME_TYPE_LABELS, normalize_game_document
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
    """Marketing homepage with a few random public games."""
    public_ids = list(
        Game.objects.filter(is_public=True).values_list("pk", flat=True)[:200]
    )
    random.shuffle(public_ids)
    pick = public_ids[:6]
    featured_map = {
        g.pk: g
        for g in Game.objects.filter(pk__in=pick).select_related("owner")
    }
    featured = [featured_map[i] for i in pick if i in featured_map]
    return render(
        request,
        "home.html",
        {
            "featured_games": featured,
            "game_type_labels": GAME_TYPE_LABELS,
        },
    )


@login_required
@require_GET
def dashboard(request: HttpRequest) -> HttpResponse:
    """Creator dashboard: cards for owned games + import."""
    games = list(
        Game.objects.filter(owner=request.user)
        .select_related("owner")
        .order_by("-updated_at")
    )
    limits = limits_for_request(request)
    return render(
        request,
        "dashboard.html",
        {
            "games": games,
            "limits": limits_to_dict(limits),
            "game_count": len(games),
        },
    )


@require_GET
def gallery(request: HttpRequest) -> HttpResponse:
    """Public gallery of playable games."""
    qs = (
        Game.objects.filter(is_public=True)
        .select_related("owner")
        .order_by("-updated_at")
    )
    game_type = (request.GET.get("type") or "").strip()
    if game_type in GAME_TYPE_LABELS:
        # Filter in Python for JSONField simplicity (SQLite-friendly enough at beta scale)
        games = [g for g in qs[:200] if g.game_type == game_type]
    else:
        games = list(qs[:100])
        game_type = ""
    return render(
        request,
        "gallery.html",
        {
            "games": games,
            "filter_type": game_type,
            "game_type_labels": GAME_TYPE_LABELS,
        },
    )


@require_GET
def play_game(request: HttpRequest, share_code: str) -> HttpResponse:
    """Player-facing play page (shareable)."""
    game = get_object_or_404(Game.objects.select_related("owner"), share_code=share_code)
    is_owner = request.user.is_authenticated and game.owner_id == request.user.id
    if not game.is_public and not is_owner:
        return HttpResponseForbidden("This game is not public.")
    document = normalize_game_document(
        game.definition, limits=limits_for_request(request)
    )
    return render(
        request,
        "play.html",
        {
            "game": game,
            "game_document": document,
            "game_document_json": json.dumps(document),
            "is_owner": is_owner,
            "can_download": game.allow_download or is_owner,
        },
    )


@require_GET
def export_game_json(request: HttpRequest, share_code: str) -> HttpResponse:
    """Download OpenTD JSON export when allow_download (or owner)."""
    game = get_object_or_404(Game, share_code=share_code)
    is_owner = request.user.is_authenticated and game.owner_id == request.user.id
    if not game.allow_download and not is_owner:
        return HttpResponseForbidden("Download is disabled for this game.")
    if not game.is_public and not is_owner:
        return HttpResponseForbidden("This game is not public.")
    limits = limits_for_request(request)
    payload = build_export_payload(
        title=game.title, definition=game.definition, limits=limits
    )
    body = json.dumps(payload, indent=2, ensure_ascii=False)
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in game.title)[:40]
    resp = HttpResponse(body, content_type="application/json; charset=utf-8")
    resp["Content-Disposition"] = f'attachment; filename="{safe_name or "game"}.opentd.json"'
    return resp


@login_required
@require_http_methods(["GET", "POST"])
def import_game(request: HttpRequest) -> HttpResponse:
    """Import a portable OpenTD JSON file as a new owned game."""
    limits = limits_for_request(request)
    if request.method == "GET":
        return redirect("dashboard")

    owned = Game.objects.filter(owner=request.user).count()
    if owned >= limits.max_games:
        messages.error(
            request,
            f"You already have {owned} games (limit {limits.max_games}).",
        )
        return redirect("dashboard")

    upload = request.FILES.get("file")
    raw_text = request.POST.get("json_text", "")
    try:
        if upload:
            data = upload.read(MAX_REQUEST_BODY_BYTES + 1)
            if len(data) > MAX_REQUEST_BODY_BYTES:
                raise ValueError("File too large.")
            payload = json.loads(data.decode("utf-8"))
        elif raw_text.strip():
            if len(raw_text.encode("utf-8")) > MAX_REQUEST_BODY_BYTES:
                raise ValueError("JSON text too large.")
            payload = json.loads(raw_text)
        else:
            raise ValueError("Choose a JSON file or paste JSON.")
        title, definition = parse_import_payload(payload, limits=limits)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        messages.error(request, f"Invalid JSON: {exc}")
        return redirect("dashboard")
    except ValueError as exc:
        messages.error(request, str(exc))
        return redirect("dashboard")

    game = Game.objects.create(
        owner=request.user,
        title=title,
        definition=definition,
        is_public=False,
        allow_download=False,
    )
    messages.success(request, f'Imported “{game.title}”.')
    return redirect(f"/editor/?game={game.pk}")


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
            "game_is_public": bool(owned_game.is_public) if owned_game else False,
            "game_allow_download": bool(owned_game.allow_download) if owned_game else False,
            "game_share_code": owned_game.share_code if owned_game else "",
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
    if "is_public" in payload:
        game.is_public = bool(payload.get("is_public"))
    if "allow_download" in payload:
        game.allow_download = bool(payload.get("allow_download"))
    game.save()
    return JsonResponse(
        {
            "ok": True,
            "game_id": game.pk,
            "title": game.title,
            "share_code": game.share_code,
            "is_public": game.is_public,
            "allow_download": game.allow_download,
        }
    )


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
        n = limits.max_games
        return JsonResponse(
            {
                "ok": False,
                "error": f"You can only have {n} game{'s' if n != 1 else ''} on this account.",
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
        is_public=bool(payload.get("is_public", False)),
        allow_download=bool(payload.get("allow_download", False)),
    )
    return JsonResponse(
        {
            "ok": True,
            "game_id": game.pk,
            "title": game.title,
            "share_code": game.share_code,
            "is_public": game.is_public,
            "allow_download": game.allow_download,
        }
    )


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
