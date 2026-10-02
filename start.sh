#!/usr/bin/env sh
# shortsforge launcher for macOS / Linux.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8765}"
HOST="${HOST:-127.0.0.1}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[x] $1 is not installed. $2"
    exit 1
  fi
}
need uv "Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
need ffmpeg "Install: brew install ffmpeg  (macOS)  |  sudo apt install ffmpeg  (Debian/Ubuntu)"
need ffprobe "It ships with ffmpeg - reinstall ffmpeg."

echo "Checking dependencies (the first run downloads Python packages and takes a few minutes)..."
uv sync --frozen --quiet

URL="http://localhost:$PORT"
echo
echo "  shortsforge is running at  $URL"
echo "  Press Ctrl+C to stop it."
echo
(
  sleep 4
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  fi
) &
exec uv run --frozen uvicorn backend.main:app --host "$HOST" --port "$PORT"
