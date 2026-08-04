#!/bin/sh
set -e

# Ensure host-mounted data dir exists for SQLite (and siblings for static/media).
mkdir -p /data/django-apps/opentd /app/staticfiles /app/mediafiles 2>/dev/null || true

echo " === Database path === "
uv run --no-sync python -c "from django.conf import settings; import django; import os; os.environ.setdefault('DJANGO_SETTINGS_MODULE','opentd.settings'); django.setup(); print(settings.DATABASES['default']['NAME'])"

echo " === Running database migrations... === "
uv run --no-sync python manage.py migrate --noinput

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

echo " === Starting Gunicorn... === "
exec "$@"
