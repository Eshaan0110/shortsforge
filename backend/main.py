import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from . import clipper, downloader, transcriber
from .tools import ToolError

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
CACHE_DIR = ROOT / "cache"
OUTPUT_DIR = ROOT / "output"

CACHE_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="shortsforge")


def _bad(message: str, code: int = 400) -> HTTPException:
    return HTTPException(code, {"error": message})


def _tool_error(e: ToolError) -> HTTPException:
    return HTTPException(502, {"error": e.message, "stderr": e.stderr})


def _check_id(video_id: str) -> None:
    if not downloader.ID_RE.match(video_id):
        raise _bad("Invalid video_id")


class FetchReq(BaseModel):
    url: str


class Keyframe(BaseModel):
    time: float = Field(ge=0)  # seconds from clip start; clamped to the clip length when rendering
    x: float = Field(ge=0, le=1)  # box, as fractions of the source frame
    y: float = Field(ge=0, le=1)
    width: float = Field(ge=0.05, le=1)
    height: float = Field(ge=0.05, le=1)
    ease: Literal["smooth", "snap"] = "smooth"  # motion from this keyframe to the next


class CropSettings(BaseModel):
    crop_mode: Literal["fixed", "custom", "fit"] = "fixed"
    crop_x: float = Field(0.5, ge=0, le=1)  # fixed mode: 0 = left, 0.5 = center, 1 = right
    keyframes: list[Keyframe] = Field(default_factory=list, max_length=200)  # custom mode
    pad: Literal["blur", "black", "color"] = "blur"  # fit mode: what fills the space around the frame
    pad_color: str = Field("#000000", pattern=r"^#[0-9a-fA-F]{6}$")

    @model_validator(mode="after")
    def _check_keyframes(self):
        if self.crop_mode == "custom":
            if not self.keyframes:
                raise ValueError("custom crop needs at least one keyframe")
            for i, k in enumerate(self.keyframes, 1):
                if k.x + k.width > 1.001 or k.y + k.height > 1.001:
                    raise ValueError(f"keyframe {i}: crop box goes outside the frame")
        return self

    def keyframe_dicts(self) -> list[dict] | None:
        return [k.model_dump() for k in self.keyframes] if self.crop_mode == "custom" else None

    def fit_dict(self) -> dict | None:
        return {"pad": self.pad, "color": self.pad_color} if self.crop_mode == "fit" else None


class ClipReq(CropSettings):
    video_id: str
    start: float | str
    end: float | str
    captions: bool = False


class Range(BaseModel):
    start: float | str
    end: float | str


class TranscribeReq(Range):
    video_id: str


class BatchReq(CropSettings):
    video_id: str
    ranges: list[Range]
    captions: bool = False


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/fetch")
def fetch(req: FetchReq):
    url = req.url.strip()
    if not url.startswith(("http://", "https://")):
        raise _bad("URL must start with http:// or https://")
    try:
        meta = downloader.fetch(url, CACHE_DIR)
    except ToolError as e:
        raise _tool_error(e)
    # No transcription here: only clip ranges get transcribed (POST /api/transcribe, or on Generate with captions).
    return meta


def _clip_range(video_id: str, start_raw, end_raw) -> tuple[Path, float, float]:
    """Validate a video + time range; returns (source path, start, end) with end clamped to the video."""
    _check_id(video_id)
    src = CACHE_DIR / f"{video_id}.mp4"
    if not src.exists():
        raise _bad("Video not fetched yet - click Fetch Video first", 404)
    try:
        start, end = clipper.parse_time(start_raw), clipper.parse_time(end_raw)
    except ValueError as e:
        raise _bad(str(e))

    meta = downloader.load_meta(CACHE_DIR, video_id) or {}
    duration = meta.get("duration")
    if duration:
        if start >= duration:
            raise _bad(f"Start is past the end of the video ({duration:.0f}s long)")
        end = min(end, float(duration))
    if end <= start:
        raise _bad("End must be after start")
    return src, start, end


def _render(video_id: str, start_raw, end_raw, captions: bool, crop: CropSettings) -> dict:
    src, start, end = _clip_range(video_id, start_raw, end_raw)

    cues = None
    if captions:
        try:  # transcribes just this range if it isn't cached yet (blocks until done)
            segments = transcriber.ensure_range(CACHE_DIR, video_id, start, end)
        except RuntimeError as e:
            raise HTTPException(502, {"error": f"Transcription failed: {e}"})
        cues = transcriber.cues_for_range(segments, start, end)

    try:
        filename = clipper.make_clip(
            src, OUTPUT_DIR, video_id, start, end, cues, CACHE_DIR,
            crop.crop_x, crop.keyframe_dicts(), crop.fit_dict(),
        )
    except ToolError as e:
        raise _tool_error(e)
    return {"filename": filename, "start": start, "end": end}


@app.post("/api/clip")
def clip(req: ClipReq):
    return _render(req.video_id, req.start, req.end, req.captions, req)


@app.get("/api/clips")
def clips():
    files = [p for p in OUTPUT_DIR.glob("*.mp4") if not p.name.endswith(".part.mp4")]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"filename": p.name, "size": p.stat().st_size, "modified": p.stat().st_mtime} for p in files]


@app.delete("/api/clips/{filename}")
def delete_clip(filename: str):
    # Bare *.mp4 names only, so a crafted name can't reach outside output/.
    path = OUTPUT_DIR / filename
    if Path(filename).name != filename or not filename.endswith(".mp4") or not path.is_file():
        raise _bad("Clip not found", 404)
    try:
        path.unlink()
    except PermissionError:
        raise _bad("Clip is in use (still playing or downloading?) - try again in a moment", 409)
    return {"deleted": filename}


@app.post("/api/transcribe")
def transcribe(req: TranscribeReq):
    """Start transcribing just one clip range (background). Poll GET /api/transcript/{id}?start=&end=."""
    _, start, end = _clip_range(req.video_id, req.start, req.end)
    transcriber.enqueue(CACHE_DIR, req.video_id, (start, end))
    return {**transcriber.status(CACHE_DIR, req.video_id, (start, end)), "start": start, "end": end}


@app.get("/api/transcript/{video_id}")
def transcript(video_id: str, start: float | None = None, end: float | None = None):
    """Transcript for a range (start + end), or whatever whole-video transcript is cached (no params).

    Nothing is started here — a "missing" status means: POST /api/transcribe first.
    """
    _check_id(video_id)
    rng = (start, end) if start is not None and end is not None else None
    return transcriber.status(CACHE_DIR, video_id, rng)


# --- Batch mode -------------------------------------------------------------

_batch_jobs: dict[str, dict] = {}


def _run_batch(job: dict, req: BatchReq) -> None:
    for i, r in enumerate(req.ranges):
        job["current"] = i
        item = {"start": r.start, "end": r.end}
        try:
            item.update(_render(req.video_id, r.start, r.end, req.captions, req))
        except HTTPException as e:
            item.update(e.detail if isinstance(e.detail, dict) else {"error": str(e.detail)})
        except Exception as e:
            item["error"] = f"{type(e).__name__}: {e}"
        job["results"].append(item)
        job["done"] += 1
    job["status"] = "done"
    job["current"] = None


@app.post("/api/batch")
def batch(req: BatchReq):
    _check_id(req.video_id)
    if not req.ranges:
        raise _bad("No time ranges given")
    job_id = uuid.uuid4().hex[:12]
    job = {"status": "running", "total": len(req.ranges), "done": 0, "current": 0, "results": []}
    _batch_jobs[job_id] = job
    threading.Thread(target=_run_batch, args=(job, req), daemon=True).start()
    return {"job_id": job_id, "total": job["total"]}


@app.get("/api/batch/{job_id}")
def batch_status(job_id: str):
    job = _batch_jobs.get(job_id)
    if job is None:
        raise _bad("Unknown batch job (the server may have restarted)", 404)
    return job


# --- Static files (mounted last so /api/* wins) ------------------------------

app.mount("/output", StaticFiles(directory=OUTPUT_DIR), name="output")
app.mount("/cache", StaticFiles(directory=CACHE_DIR), name="cache")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
