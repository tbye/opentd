# OpenTD.org

[opentd.org](https://opentd.org) is a platform allowing anyone to create a tower defense game that runs in the browser.

## Use of AI

AI is unapologetically used throughout this project. Human optimizations are encouraged and welcome.

## Stack

| Layer | Choice |
| --- | --- |
| Backend | Django 6 |
| Partial HTML | django-htmx + **htmx 4** ([four.htmx.org](https://four.htmx.org)) |
| CSS | **Tailwind CSS 4** + **DaisyUI** via standalone CLI (**no Node/npm**) |
| Auth | django-allauth (email login, mandatory email verification) |
| Email | Resend via django-anymail (console backend when no API key) |

## Setup

```bash
# Install Python deps (uv)
uv sync

# Copy env template and optionally set RESEND_API_KEY
cp .env.example .env

# Database
uv run python manage.py migrate

# Create a superuser (optional)
uv run python manage.py createsuperuser

# Compile CSS (Tailwind standalone CLI — no Node)
# Requires `tailwindcss` on PATH (e.g. ~/.local/bin/tailwindcss)
./scripts/build-css.sh
# or watch:
./scripts/build-css.sh --watch

# Run the dev server (serves static/ + media/)
uv run python manage.py runserver
```

Open http://127.0.0.1:8000/

## Docker

Production-style layout (mirrors other TBYE Django apps):

| Service | Port | Role |
| --- | --- | --- |
| `app` | **8080** | Gunicorn (Django) |
| `static` | **8180** | Caddy file server for `staticfiles` + `mediafiles` |

Data lives on the host under `/data/django-apps/opentd/` (SQLite, static, media).

```bash
# Build & run (requires external Coolify network when used with Coolify)
docker compose up -d --build
```

Set `DJANGO_SECRET_KEY`, `RESEND_API_KEY`, `DJANGO_SUPERUSER_*`, etc. via the environment or a `.env` next to `docker-compose.yaml`.

### Closed beta & security

- Signups queue for **staff approval** at `/staff/beta-signups/` (approve sends the verification email; reject hides the row).
- **Cloudflare Turnstile** on signup when `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` are set.
- Guest vs registered **entity caps** are enforced server-side and shown in the editor.
- Rate limits (IP + session) apply to draft saves, signup, password reset, and game save/create.
- Stale guest drafts are purged on deploy (`cleanup_pending_games`, default 14 days).

#### Cloudflare Turnstile setup

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Turnstile** → **Add site**.
2. Widget name: e.g. `OpenTD signup`.
3. Domains: `opentd.org`, `localhost` (and any staging host).
4. Widget mode: **Managed** (recommended).
5. Copy **Site Key** → `TURNSTILE_SITE_KEY` and **Secret Key** → `TURNSTILE_SECRET_KEY` into Coolify/env.
6. Redeploy; signup will show the captcha widget.

Without Turnstile keys, signup still works (closed beta queue remains the gate).

### Tailwind / DaisyUI (no Node)

CSS is built with the [Tailwind standalone CLI](https://tailwindcss.com/blog/standalone-cli) and DaisyUI’s single-file plugins:

```text
static/css/
  input.css          # entry (@import tailwindcss, @plugin daisyui)
  daisyui.mjs        # DaisyUI plugin (downloaded)
  daisyui-theme.mjs  # theme plugin (downloaded)
  output.css         # compiled output (served by Django)
```

Install the CLI once (Linux x64 example):

```bash
curl -sL -o ~/.local/bin/tailwindcss \
  https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-linux-x64
chmod +x ~/.local/bin/tailwindcss
```

Refresh DaisyUI plugins if needed:

```bash
cd static/css
curl -sLO https://github.com/saadeghi/daisyui/releases/latest/download/daisyui.mjs
curl -sLO https://github.com/saadeghi/daisyui/releases/latest/download/daisyui-theme.mjs
```

### Email (Resend)

Without `RESEND_API_KEY`, verification and password-reset messages print to the **console** (the process running `runserver`).

With a Resend key:

```bash
# .env
RESEND_API_KEY=re_...
DEFAULT_FROM_EMAIL=OpenTD <you@your-verified-domain.com>
```

django-anymail talks to Resend’s HTTP API (not a long-lived SMTP connection).

### Guest editor & saving

Anyone can open **`/editor/`** and paint a map with no account.

| Step | What happens |
| --- | --- |
| Guest edits | Draft autosaves to a `PendingGame` tied to the browser session |
| **Sign up to save** | Draft is locked and linked to the new user on `user_signed_up` |
| Email verified | `email_confirmed` promotes the draft to a real `Game` owned by the user |

### Completeness

A game needs **≥1 Spawn** and **≥1 Exit** (shown at the top of the editor palette).

### Game types (`settings.game_type`)

| Type | Key | Behavior |
| --- | --- | --- |
| **Monster March** | `monster_march` | Monsters follow painted path cells toward an exit. |
| **Monster Rush** | `monster_rush` | No fixed path. Players maze with towers & walls. If no open route spawn→exit, monsters attack walls/towers on the shortest path. When a free path opens they follow it and stop attacking — unless **chaos mode** is on. |
| **Defend the Castle** | `defend_the_castle` | Monsters try to destroy a central castle tower. |

**Chaos mode** (`settings.chaos_mode`, Monster Rush only): monsters keep destroying obstacles on the shortest path to the exit even after a free lane exists.

Grid cells: **spawn**, **exit**, **path**, **tower pad**, **ground**, **wall (blocked)**.  
Multiple spawns/exits; ids default to `1`, `2`, … (renameable alphanumeric).  
Per-spawn exit mode: **any exit** or **specific exit**.

Palette order: **Spawns & exits** → **Game settings** → terrain → **Towers** → **Monsters**.

## Auth routes

| Path | Purpose |
| --- | --- |
| `/editor/` | Guest-friendly map editor |
| `/accounts/signup/` | Register (sends verification email) |
| `/accounts/login/` | Email + password |
| `/accounts/confirm-email/...` | Email verification link |
| `/accounts/password/reset/` | Password reset |
| `/accounts/email/` | Manage email addresses |
| `/admin/` | Django admin |

`ACCOUNT_EMAIL_VERIFICATION = "mandatory"` — users must verify email before login.

## Static & media

| Setting | Path |
| --- | --- |
| Project static | `static/` → `/static/` |
| Collected static | `staticfiles/` (`collectstatic`) |
| User uploads | `mediafiles/` → `/media/` |

In `DEBUG`, `runserver` serves both static (via `django.contrib.staticfiles`) and media (via `urls.py`).

## License

MIT — see [LICENSE](LICENSE).
