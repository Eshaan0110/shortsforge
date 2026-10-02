"""yt-dlp download wrapper. Videos are cached as cache/<id>.mp4 with metadata in cache/<id>.json."""

import json
import re
import shutil
import sys
import threading
from pathlib import Path

from .tools import ToolError, run

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_YT_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)

# Prefer H.264 (plays everywhere, fast to decode), cap at 1080p, fall back progressively.
FORMAT = (
    "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/"
    "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/"
    "b[height<=1080][ext=mp4]/b[height<=1080]/b"
)

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def ytdlp_cmd() -> list[str]:
    """Prefer a yt-dlp binary on PATH; fall back to the venv's Python package."""
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    return [sys.executable, "-m", "yt_dlp"]


def _lock_for(video_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(video_id, threading.Lock())


def load_meta(cache_dir: Path, video_id: str) -> dict | None:
    meta_path = cache_dir / f"{video_id}.json"
    if (cache_dir / f"{video_id}.mp4").exists() and meta_path.exists():
        return json.loads(meta_path.read_text(encoding="utf-8"))
    return None


def fetch(url: str, cache_dir: Path) -> dict:
    # Fast path: recognisable YouTube URL that is already cached -> no network at all.
    m = _YT_ID_RE.search(url)
    if m and (cached := load_meta(cache_dir, m.group(1))):
        return cached

    proc = run(ytdlp_cmd() + ["-J", "--no-playlist", "--no-warnings", url], "yt-dlp (metadata)")
    try:
        info = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise ToolError("yt-dlp returned unreadable metadata", proc.stderr or proc.stdout[:2000])

    video_id = str(info.get("id", ""))
    if not ID_RE.match(video_id):
        raise ToolError(f"Unsupported video id from yt-dlp: {video_id!r}")

    with _lock_for(video_id):
        if cached := load_meta(cache_dir, video_id):
            return cached
        mp4 = cache_dir / f"{video_id}.mp4"
        if not mp4.exists():
            run(
                ytdlp_cmd()
                + [
                    "--no-playlist",
                    "--no-warnings",
                    "-f", FORMAT,
                    "--merge-output-format", "mp4",
                    "--remux-video", "mp4",
                    "-o", str(cache_dir / "%(id)s.%(ext)s"),
                    url,
                ],
                "yt-dlp (download)",
            )
        if not mp4.exists():
            raise ToolError(f"yt-dlp finished but {mp4.name} was not created")

        meta = {
            "video_id": video_id,
            "filename": mp4.name,
            "duration": info.get("duration"),
            "title": info.get("title") or video_id,
        }
        (cache_dir / f"{video_id}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return meta
