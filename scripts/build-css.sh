#!/usr/bin/env bash
# Compile Tailwind CSS 4 + DaisyUI with the standalone CLI (no Node/npm).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CSS_DIR="$ROOT/static/css"
INPUT="$CSS_DIR/input.css"
OUTPUT="$CSS_DIR/output.css"

if ! command -v tailwindcss >/dev/null 2>&1; then
  echo "error: tailwindcss CLI not found on PATH." >&2
  echo "Install the standalone binary, e.g.:" >&2
  echo "  curl -sL -o ~/.local/bin/tailwindcss \\" >&2
  echo "    https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-linux-x64" >&2
  echo "  chmod +x ~/.local/bin/tailwindcss" >&2
  exit 1
fi

if [[ ! -f "$CSS_DIR/daisyui.mjs" ]]; then
  echo "error: missing $CSS_DIR/daisyui.mjs" >&2
  echo "  cd static/css && curl -sLO https://github.com/saadeghi/daisyui/releases/latest/download/daisyui.mjs" >&2
  exit 1
fi

args=(-i "$INPUT" -o "$OUTPUT")
if [[ "${1:-}" == "--watch" || "${1:-}" == "-w" ]]; then
  args+=(--watch)
  echo "Watching $INPUT → $OUTPUT"
else
  args+=(--minify)
  echo "Building $OUTPUT"
fi

exec tailwindcss "${args[@]}"
