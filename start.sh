#!/usr/bin/env sh
# shortsforge launcher for macOS / Linux: installs what's missing, then starts the app.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8765}"
HOST="${HOST:-127.0.0.1}"
URL="http://localhost:$PORT"
# uv's installer puts uv here; add it so a fresh install is found without a new terminal.
PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export PATH

say() { printf '%s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }

fail() {
  say ""
  say "[x] $*"
  say "    Fix the problem above, then run ./start.sh again."
  exit 1
}

# ask "Question?"  -> success only if the user answers y/yes (or SHORTSFORGE_YES is set)
ask() {
  [ -n "${SHORTSFORGE_YES:-}" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer || return 1
  case "$answer" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

open_url() {
  if has open; then open "$1"
  elif has xdg-open; then xdg-open "$1" >/dev/null 2>&1
  fi
}

is_running() {
  has curl && curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}

say ""
say " =================================================="
say "   shortsforge  -  turn YouTube videos into Shorts"
say " =================================================="
say ""

if is_running; then
  say " shortsforge is already running - opening $URL"
  [ -z "${SHORTSFORGE_NO_BROWSER:-}" ] && open_url "$URL"
  exit 0
fi

say " [1/3] Checking uv ..."
if ! has uv; then
  say "       uv is missing. It runs shortsforge and installs Python for it automatically."
  ask "       Install uv now?" || fail "uv is required. Install it from https://docs.astral.sh/uv/"
  if has curl; then
    curl -LsSf https://astral.sh/uv/install.sh | sh || fail "Installing uv failed."
  elif has wget; then
    wget -qO- https://astral.sh/uv/install.sh | sh || fail "Installing uv failed."
  else
    fail "Neither curl nor wget is available to download uv. Install one of them first."
  fi
  has uv || fail "uv was installed but can't be found yet. Open a new terminal and run ./start.sh again."
fi

say " [2/3] Checking ffmpeg ..."
if ! has ffmpeg || ! has ffprobe; then
  say "       ffmpeg is missing. It cuts and renders the videos."
  if has brew; then install="brew install ffmpeg"
  elif has apt-get; then install="sudo apt-get update && sudo apt-get install -y ffmpeg"
  elif has dnf; then install="sudo dnf install -y ffmpeg-free"
  elif has pacman; then install="sudo pacman -S --noconfirm ffmpeg"
  elif has zypper; then install="sudo zypper install -y ffmpeg"
  elif [ "$(uname)" = "Darwin" ]; then
    fail "Install Homebrew from https://brew.sh, then run: brew install ffmpeg"
  else
    fail "Install ffmpeg with your system's package manager (https://ffmpeg.org/download.html)."
  fi
  ask "       Install it now with:  $install  ?" || fail "ffmpeg is required. Install it with:  $install"
  sh -c "$install" || fail "Installing ffmpeg failed."
  { has ffmpeg && has ffprobe; } || fail "ffmpeg was installed but can't be found yet. Open a new terminal and run ./start.sh again."
fi

say " [3/3] Setting up the app - the first run downloads Python and packages, this takes a few minutes ..."
uv sync --frozen --quiet || fail "Installing the app's packages failed - see the message above."

say ""
say " --------------------------------------------------"
say "   shortsforge is running:  $URL"
say "   Your browser will open by itself."
say ""
say "   KEEP THIS TERMINAL OPEN while you use the app."
say "   Press Ctrl+C when you are done to stop shortsforge."
say " --------------------------------------------------"
say ""

# Open the browser as soon as the server answers (or after a short wait if curl isn't available).
if [ -z "${SHORTSFORGE_NO_BROWSER:-}" ]; then
  (
    if has curl; then
      i=0
      while [ "$i" -lt 240 ]; do
        if is_running; then open_url "$URL"; break; fi
        i=$((i + 1))
        sleep 0.5
      done
    else
      sleep 5
      open_url "$URL"
    fi
  ) &
fi

exec uv run --frozen uvicorn backend.main:app --host "$HOST" --port "$PORT" --log-level warning
