#!/bin/sh
set -e

# Ensure host-mounted data dir exists for SQLite rollback (and siblings for static/media).
mkdir -p /data/django-apps/opentd /app/staticfiles /app/mediafiles 2>/dev/null || true

echo " === Database === "
uv run --no-sync python -c "from django.conf import settings; import django; import os; os.environ.setdefault('DJANGO_SETTINGS_MODULE','opentd.settings'); django.setup(); db=settings.DATABASES['default']; print(db.get('ENGINE'), db.get('NAME'), db.get('HOST',''))"

echo " === Running database migrations... === "
uv run --no-sync python manage.py migrate --noinput

echo " === Syncing Sites framework (OpenTD.org)... === "
uv run --no-sync python -c "
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'opentd.settings')
import django
django.setup()
from django.conf import settings
from django.contrib.sites.models import Site
domain = (settings.SITE_DOMAIN or 'opentd.org').replace('https://','').replace('http://','').split('/')[0]
Site.objects.update_or_create(pk=settings.SITE_ID, defaults={'name': settings.SITE_NAME or 'OpenTD.org', 'domain': domain})
print('Site:', domain, settings.SITE_NAME)
"

# Create superuser using Django's built-in command (only if password is set)
if [ -n "$DJANGO_SUPERUSER_PASSWORD" ]; then
  echo " === Creating Django superuser (if it doesn't already exist)... === "
  # --noinput makes it non-interactive.
  # We allow it to fail gracefully if the user already exists.
  uv run --no-sync python manage.py createsuperuser --noinput || \
    echo " → Superuser already exists or creation skipped (this is normal on restarts)."
fi

echo " === Collecting static files... === "
uv run --no-sync python manage.py collectstatic --noinput --clear

echo " === Cleaning stale pending drafts (14d) === "
uv run --no-sync python manage.py cleanup_pending_games --days "${PENDING_GAME_RETENTION_DAYS:-14}" || true

if [ "${DEBUG:-False}" = "False" ] || [ "${DEBUG:-false}" = "false" ] || [ "${DEBUG:-0}" = "0" ]; then
  echo " === Django deploy checks === "
  uv run --no-sync python manage.py check --deploy || true
fi

echo " === Starting Gunicorn... === "
exec "$@"
