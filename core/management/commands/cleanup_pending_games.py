"""Delete stale pending drafts and old rate-limit buckets."""

from __future__ import annotations

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.models import PendingGame
from core.ratelimit import purge_old_buckets


class Command(BaseCommand):
    help = (
        "Remove PendingGame rows older than --days (default 14) and "
        "purge expired rate-limit counters."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=14,
            help="Delete pending games not updated within this many days.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print counts without deleting.",
        )

    def handle(self, *args, **options):
        days = max(1, options["days"])
        dry = options["dry_run"]
        cutoff = timezone.now() - timedelta(days=days)
        qs = PendingGame.objects.filter(updated_at__lt=cutoff)
        count = qs.count()
        if dry:
            self.stdout.write(f"Would delete {count} pending game(s) older than {days}d.")
        else:
            deleted, _ = qs.delete()
            self.stdout.write(self.style.SUCCESS(f"Deleted {deleted} pending game row(s)."))

        if dry:
            self.stdout.write("Would purge old rate-limit buckets.")
        else:
            n = purge_old_buckets(older_than_seconds=86_400)
            self.stdout.write(self.style.SUCCESS(f"Purged {n} rate-limit bucket(s)."))
