"""Background faster-whisper transcription of a clip range (or, legacy, a whole video).

Results persist as cache/<id>.<start>-<end>.transcript.json (or cache/<id>.transcript.json).
"""

import fnmatch
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .tools import STDERR_TAIL

MODEL_NAME = os.environ.get("SHORTSFORGE_WHISPER_MODEL", "base")
MODEL_FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]
MODEL_CHUNK = 4 * 1024 * 1024
MODEL_CONNECTIONS = 8

# Caption chunking for burned-in subtitles: short, punchy lines suit vertical video.
MAX_WORDS_PER_CUE = 5
MAX_CHARS_PER_CUE = 28
MAX_GAP = 0.8

_model = None
_status: dict[str, dict] = {}  # job key -> {"status": "queued"|"downloading_model"|"processing"|"error", ...}
_status_lock = threading.Lock()
_jobs: queue.Queue = queue.Queue()
_worker: threading.Thread | None = None

# A job transcribes either the whole video (rng=None, legacy) or one clip range (start, end).
# Range transcripts are stored with times in SOURCE seconds, so caption cues and
# click-to-seek work the same as for a whole-video transcript.
Range = tuple[float, float] | None
_ACTIVE = ("queued", "downloading_model", "processing")
_RANGE_FILE = re.compile(r"^(?P<vid>[A-Za-z0-9_-]+)\.(?P<s>\d+(?:\.\d+)?)-(?P<e>\d+(?:\.\d+)?)\.transcript\.json$")


def _tag(t: float) -> str:
    return f"{t:.2f}".rstrip("0").rstrip(".")


def _norm(rng: Range) -> Range:
    return None if rng is None else (round(rng[0], 2), round(rng[1], 2))


def _key(video_id: str, rng: Range) -> str:
    return video_id if rng is None else f"{video_id}@{_tag(rng[0])}-{_tag(rng[1])}"


def _path(cache_dir: Path, video_id: str, rng: Range = None) -> Path:
    if rng is None:
        return cache_dir / f"{video_id}.transcript.json"
    return cache_dir / f"{video_id}.{_tag(rng[0])}-{_tag(rng[1])}.transcript.json"


def _read(p: Path) -> list[dict]:
    return json.loads(p.read_text(encoding="utf-8"))


def enqueue(cache_dir: Path, video_id: str, rng: Range = None) -> None:
    global _worker
    rng = _norm(rng)
    if find_segments(cache_dir, video_id, rng) is not None:
        return
    key = _key(video_id, rng)
    with _status_lock:
        if _status.get(key, {}).get("status") in _ACTIVE:
            return
        _status[key] = {"status": "queued"}
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, daemon=True, name="transcriber")
            _worker.start()
    _jobs.put((cache_dir, video_id, rng))


def find_segments(cache_dir: Path, video_id: str, rng: Range = None) -> list[dict] | None:
    """Cached segments that cover rng: a whole-video transcript, or any range transcript spanning it."""
    full = _path(cache_dir, video_id)
    if full.exists():
        return _read(full)
    if rng is None:
        return None
    s, e = _norm(rng)
    for p in cache_dir.glob(f"{video_id}.*.transcript.json"):
        m = _RANGE_FILE.match(p.name)
        if m and m["vid"] == video_id and float(m["s"]) <= s + 0.01 and float(m["e"]) >= e - 0.01:
            return _read(p)
    return None


def status(cache_dir: Path, video_id: str, rng: Range = None) -> dict:
    rng = _norm(rng)
    segments = find_segments(cache_dir, video_id, rng)
    if segments is not None:
        if rng is not None:  # only the part the caller asked for
            segments = [s for s in segments if s["end"] > rng[0] and s["start"] < rng[1]]
        return {
            "status": "done",
            "segments": [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in segments],
        }
    with _status_lock:
        return dict(_status.get(_key(video_id, rng), {"status": "missing"}))


def ensure_range(cache_dir: Path, video_id: str, start: float, end: float, timeout: float = 3600) -> list[dict]:
    """Blocking: transcribe [start, end] if needed (via the single worker) and return the segments."""
    rng = _norm((start, end))
    enqueue(cache_dir, video_id, rng)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        segments = find_segments(cache_dir, video_id, rng)
        if segments is not None:
            return segments
        with _status_lock:
            st = _status.get(_key(video_id, rng), {})
        if st.get("status") == "error":
            raise RuntimeError(st.get("error", "transcription failed"))
        time.sleep(0.5)
    raise RuntimeError("transcription timed out")


def _http(url: str, headers: dict | None = None, timeout: float = 30):
    req = urllib.request.Request(url, headers={"User-Agent": "shortsforge", **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def _download_chunked(url: str, dest: Path, size: int, on_bytes) -> None:
    """Parallel ranged download with per-chunk retries; finished chunks survive restarts."""
    with _http(url, {"Range": "bytes=0-0"}) as r:
        final_url = r.geturl()  # resolve the CDN redirect once, reuse for every chunk
    parts_dir = dest.with_name(dest.name + ".parts")
    parts_dir.mkdir(exist_ok=True)
    chunks = [(i, a, min(a + MODEL_CHUNK, size) - 1) for i, a in enumerate(range(0, size, MODEL_CHUNK))]

    def get(chunk):
        i, a, b = chunk
        part, want = parts_dir / f"{i:05d}", b - a + 1
        if part.exists() and part.stat().st_size == want:
            on_bytes(want)
            return
        last = None
        for attempt in range(10):
            try:
                with _http(final_url, {"Range": f"bytes={a}-{b}"}) as r:
                    data = r.read()
                if len(data) != want:
                    raise IOError(f"got {len(data)} of {want} bytes")
                part.write_bytes(data)
                on_bytes(want)
                return
            except Exception as e:
                last = e
                time.sleep(min(2 ** attempt, 15))
        raise RuntimeError(f"downloading {dest.name} failed: {last}")

    with ThreadPoolExecutor(MODEL_CONNECTIONS) as ex:
        list(ex.map(get, chunks))
    tmp = dest.with_name(dest.name + ".tmp")
    with open(tmp, "wb") as out:
        for i, _, _ in chunks:
            out.write((parts_dir / f"{i:05d}").read_bytes())
    tmp.replace(dest)
    shutil.rmtree(parts_dir, ignore_errors=True)


def _ensure_model(cache_dir: Path, on_progress) -> str:
    """Download the model ourselves: huggingface_hub's single stream stalls on slow links."""
    if Path(MODEL_NAME).is_dir():
        return MODEL_NAME
    from faster_whisper.utils import _MODELS

    repo = _MODELS.get(MODEL_NAME, MODEL_NAME)  # also accepts a raw "org/repo" id
    target = cache_dir / "models" / repo.replace("/", "--")
    if (target / ".complete").exists():
        return str(target)
    target.mkdir(parents=True, exist_ok=True)

    with _http(f"https://huggingface.co/api/models/{repo}?blobs=true") as r:
        info = json.load(r)
    files = [
        (s["rfilename"], s.get("size") or 0)
        for s in info["siblings"]
        if any(fnmatch.fnmatch(s["rfilename"], p) for p in MODEL_FILES)
    ]
    total = sum(size for _, size in files) or 1
    got = 0
    got_lock = threading.Lock()

    def on_bytes(n):
        nonlocal got
        with got_lock:
            got += n
            on_progress(got / total, total)

    for name, size in files:
        dest = target / name
        if dest.exists() and dest.stat().st_size == size:
            on_bytes(size)
            continue
        _download_chunked(f"https://huggingface.co/{repo}/resolve/{info['sha']}/{name}", dest, size, on_bytes)
    (target / ".complete").touch()
    return str(target)


def _get_model(cache_dir: Path, key: str):
    global _model
    if _model is None:
        def on_progress(frac, total):
            with _status_lock:
                _status[key] = {"status": "downloading_model", "progress": frac, "total_bytes": total}

        model_path = _ensure_model(cache_dir, on_progress)
        from faster_whisper import WhisperModel  # heavy import, keep it off server startup

        _model = WhisperModel(model_path, device="cpu", compute_type="int8")
    return _model


def _decode_audio(src: Path, rng: Range = None):
    """16 kHz mono float32 via ffmpeg (faster-whisper's bundled PyAV decoder breaks on PyAV 15+)."""
    import numpy as np

    seek = [] if rng is None else ["-ss", f"{rng[0]:.3f}", "-t", f"{rng[1] - rng[0]:.3f}"]
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", *seek, "-i", str(src),
         "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg audio decode failed: " + proc.stderr.decode("utf-8", "replace")[-STDERR_TAIL:])
    return np.frombuffer(proc.stdout, dtype=np.float32)


def _work() -> None:
    while True:
        cache_dir, video_id, rng = _jobs.get()
        key = _key(video_id, rng)
        offset = rng[0] if rng else 0.0  # range audio starts at 0; store source times
        try:
            model = _get_model(cache_dir, key)
            with _status_lock:
                _status[key] = {"status": "processing", "progress": 0.0}
            audio = _decode_audio(cache_dir / f"{video_id}.mp4", rng)
            segs, info = model.transcribe(audio, vad_filter=True, word_timestamps=True)
            out = []
            for s in segs:
                out.append({
                    "start": round(s.start + offset, 2),
                    "end": round(s.end + offset, 2),
                    "text": s.text.strip(),
                    "words": [
                        {"start": round(w.start + offset, 2), "end": round(w.end + offset, 2), "word": w.word}
                        for w in (s.words or [])
                    ],
                })
                if info.duration:
                    with _status_lock:
                        _status[key]["progress"] = min(s.end / info.duration, 1.0)
            path = _path(cache_dir, video_id, rng)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
            with _status_lock:
                _status.pop(key, None)
        except Exception as e:  # surface any failure to the UI instead of killing the worker
            with _status_lock:
                _status[key] = {"status": "error", "error": f"{type(e).__name__}: {e}"}
        finally:
            _jobs.task_done()


def cues_for_range(segments: list[dict], start: float, end: float) -> list[tuple[float, float, str]]:
    """Build short caption cues inside [start, end], re-timed relative to the clip start."""
    raw: list[tuple[float, float, str]] = []
    for seg in segments:
        if seg["end"] <= start or seg["start"] >= end:
            continue
        words = seg.get("words") or []
        if not words:
            raw.append((seg["start"], seg["end"], seg["text"]))
            continue
        group: list[dict] = []
        for w in words:
            if group:
                text = "".join(g["word"] for g in group + [w]).strip()
                if (
                    len(group) >= MAX_WORDS_PER_CUE
                    or len(text) > MAX_CHARS_PER_CUE
                    or w["start"] - group[-1]["end"] > MAX_GAP
                ):
                    raw.append((group[0]["start"], group[-1]["end"], "".join(g["word"] for g in group).strip()))
                    group = []
            group.append(w)
        if group:
            raw.append((group[0]["start"], group[-1]["end"], "".join(g["word"] for g in group).strip()))

    cues = []
    for s, e, text in raw:
        s, e = max(s, start) - start, min(e, end) - start
        if e - s >= 0.05 and text:
            cues.append((s, e, text))
    return cues
