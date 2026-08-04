"""django-allauth hooks: stash draft on signup, promote on email verify."""

from __future__ import annotations

import logging

from allauth.account.signals import email_confirmed, user_signed_up
from django.contrib import messages
from django.dispatch import receiver

from .drafts import attach_pending_to_user, promote_pending_to_game

logger = logging.getLogger(__name__)


@receiver(user_signed_up)
def on_user_signed_up(request, user, **kwargs):
    """Keep the guest's map work tied to the new account until email verify."""
    pending = attach_pending_to_user(request, user)
    if pending is not None:
        logger.info(
            "Attached pending game %s to user %s after signup",
            pending.pk,
            user.pk,
        )


@receiver(email_confirmed)
def on_email_confirmed(request, email_address, **kwargs):
    """When the address is verified, persist the pending draft as a real Game."""
    user = email_address.user
    game = promote_pending_to_game(user)
    if game is None:
        return
    logger.info("Promoted pending draft to game %s for user %s", game.pk, user.pk)
    # request may be None for some confirmation paths; messages need a request.
    if request is not None:
        messages.success(
            request,
            f'Your game “{game.title}” has been saved to your account.',
            fail_silently=True,
        )
