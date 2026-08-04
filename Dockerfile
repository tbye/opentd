FROM ghcr.io/astral-sh/uv:trixie-slim

WORKDIR /app

ARG DEBUG
ARG SECRET_KEY
ARG DATABASE_URL

RUN apt-get update && apt-get install -y \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY pyproject.toml uv.lock ./
RUN uv sync

COPY . .

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

ENTRYPOINT [ "/entrypoint.sh" ]
CMD ["uv", "run", "--locked", "--no-sync", "gunicorn", \
     "opentd.wsgi:application", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "3", \
     "--log-level", "info", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
