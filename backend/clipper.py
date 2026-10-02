"""ffmpeg cutting + 9:16 crop to 1080x1920 (fixed or keyframed), with optional burned-in captions."""

import hashlib
import json
import re
from pathlib import Path

from .tools import run


def crop_scale(crop_x: float = 0.5) -> str:
    """9:16 crop + scale. crop_x picks the horizontal position: 0 = left edge, 0.5 = center, 1 = right edge.

    min() guards sources that are already narrower than 9:16 (plain `crop=ih*9/16:ih` would fail on those).
    """
    x = min(max(crop_x, 0.0), 1.0)
    return (
        f"crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':x='(iw-ow)*{x:.4f}':y='(ih-oh)/2',"
        "scale=1080:1920,setsar=1"
    )


# --- Keyframed ("custom") crop ------------------------------------------------
# A keyframe is {"time", "x", "y", "width", "height", "ease"}: time in seconds from
# clip start, box in 0..1 fractions of the source frame, ease "smooth" | "snap".


def probe(src: Path) -> tuple[int, int, float]:
    """(width, height, fps) of the first video stream."""
    proc = run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", str(src)],
        "ffprobe",
    )
    s = json.loads(proc.stdout)["streams"][0]
    num, den = (float(p) for p in s["r_frame_rate"].split("/"))
    return int(s["width"]), int(s["height"]), (num / den if num and den else 30.0)


def normalize_keyframes(keyframes: list[dict], duration: float, src_w: int, src_h: int) -> list[dict]:
    """Sort by time, clamp times to [0, duration], and make every box exactly 9:16 in pixels.

    The box height is authoritative; width is re-derived from it (centered on the requested box)
    so the final scale to 1080x1920 never stretches the picture. Boxes are kept inside the frame.
    """
    base_w = min(1.0, src_h * 9 / 16 / src_w)  # widest possible 9:16 box, as a fraction of width
    base_h = min(1.0, src_w * 16 / 9 / src_h)  # ...and of height
    by_time: dict[float, dict] = {}
    for k in sorted(keyframes, key=lambda k: k["time"]):
        t = min(max(float(k["time"]), 0.0), duration)
        h = min(float(k["height"]), base_h)
        w = h * base_w / base_h
        cx = k["x"] + k["width"] / 2
        cy = k["y"] + k["height"] / 2
        by_time[round(t, 3)] = {  # same time twice: the later one wins
            "time": t,
            "x": min(max(cx - w / 2, 0.0), 1.0 - w),
            "y": min(max(cy - h / 2, 0.0), 1.0 - h),
            "width": w,
            "height": h,
            "ease": k.get("ease", "smooth"),
        }
    return list(by_time.values())


def _num(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") or "0"


def build_crop_expr(keyframes: list[dict], t: str = "t") -> dict[str, str]:
    """ffmpeg expressions X(t), Y(t), W(t), H(t) that interpolate between sorted keyframes.

    Shape: if(lt(t,t1), seg0, if(lt(t,t2), seg1, ... last)), where a segment is a linear
    interpolation (smooth) or the first keyframe's value held until the next one (snap).
    Before the first keyframe the first value is held; after the last, the last.
    """
    def chain(key: str) -> str:
        expr = _num(keyframes[-1][key])
        for a, b in reversed(list(zip(keyframes, keyframes[1:]))):
            span = b["time"] - a["time"]
            if a["ease"] == "snap" or span < 1e-6 or abs(b[key] - a[key]) < 1e-9:
                seg = _num(a[key])
            else:
                seg = f"{_num(a[key])}+({_num(b[key] - a[key])})*({t}-{_num(a['time'])})/{_num(span)}"
            expr = f"if(lt({t},{_num(b['time'])}),{seg},{expr})"
        if keyframes[0]["time"] > 0:
            expr = f"if(lt({t},{_num(keyframes[0]['time'])}),{_num(keyframes[0][key])},{expr})"
        return expr

    return {"X": chain("x"), "Y": chain("y"), "W": chain("width"), "H": chain("height")}


def keyframe_filter(keyframes: list[dict], src_w: int, src_h: int, fps: float) -> str:
    """Video filter for a keyframed crop, ending at 1080x1920.

    - No motion (1 keyframe, or all identical): a plain crop — pixel-exact and fastest.
    - Motion: `crop` can't animate its size (w/h are evaluated once) and moves in whole
      pixels, so we use `perspective`, which maps the moving source box onto the frame
      with sub-pixel interpolation every frame. It has no `t` variable, so time is
      derived from the input frame number: in / fps.
    """
    first = keyframes[0]
    static = all(
        all(abs(k[key] - first[key]) < 1e-6 for key in ("x", "y", "width", "height")) for k in keyframes
    )
    if static:
        pw = min(max(2, round(first["width"] * src_w / 2) * 2), src_w // 2 * 2)
        ph = min(max(2, round(first["height"] * src_h / 2) * 2), src_h // 2 * 2)
        px = min(round(first["x"] * src_w), src_w - pw)
        py = min(round(first["y"] * src_h), src_h - ph)
        return f"crop={pw}:{ph}:{px}:{py},scale=1080:1920,setsar=1"

    e = build_crop_expr(keyframes, t=f"(in/{_num(fps)})")
    left, top = f"W*({e['X']})", f"H*({e['Y']})"
    right, bottom = f"W*(({e['X']})+({e['W']}))", f"H*(({e['Y']})+({e['H']}))"
    return (
        f"perspective=x0='{left}':y0='{top}':x1='{right}':y1='{top}'"
        f":x2='{left}':y2='{bottom}':x3='{right}':y3='{bottom}'"
        ":interpolation=linear:sense=source:eval=frame,"
        "scale=1080:1920,setsar=1"
    )


# --- FIT: whole frame inside 9:16, padded -------------------------------------


def fit_filter(pad: str = "blur", color: str = "#000000") -> str:
    """Scale the full frame to fit 1080x1920 and fill the rest.

    pad="blur": a zoomed, blurred, slightly darkened copy of the video behind it (the usual Shorts look).
    pad="black"/"color": flat letterbox in black or the given #RRGGBB.
    """
    fg = "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2"
    if pad == "blur":
        return (
            "split=2[bg][fg];"
            "[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,"
            "gblur=sigma=12,eq=brightness=-0.12,scale=1080:1920[bgb];"
            f"[fg]{fg}[fgs];"
            "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1"
        )
    hexcolor = "000000" if pad == "black" else color.lstrip("#")
    return f"{fg},pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x{hexcolor},setsar=1"


# libass sizes SRT styles against a 288px-tall canvas, so these scale up ~6.7x at 1920.
CAPTION_STYLE = ",".join([
    "FontName=Arial",
    "FontSize=13",
    "Bold=1",
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&H00000000",
    "BorderStyle=1",
    "Outline=1.6",
    "Shadow=0",
    "Alignment=2",
    "MarginV=70",
    "MarginL=16",
    "MarginR=16",
])

_TIME_RE = re.compile(r"^\d+(\.\d+)?$")


def parse_time(value) -> float:
    """Accept seconds (12, 12.5, "12.5") or "MM:SS" / "HH:MM:SS" (with optional decimals)."""
    if isinstance(value, (int, float)):
        t = float(value)
    else:
        parts = str(value).strip().split(":")
        if not parts or len(parts) > 3 or not all(_TIME_RE.match(p) for p in parts):
            raise ValueError(f"Invalid time {value!r} - use seconds or MM:SS")
        t = 0.0
        for p in parts:
            t = t * 60 + float(p)
    if t < 0:
        raise ValueError(f"Time can't be negative: {value!r}")
    return t


def time_tag(t: float) -> str:
    return f"{t:.2f}".rstrip("0").rstrip(".")


def _srt_ts(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def write_srt(cues: list[tuple[float, float, str]], path: Path) -> None:
    blocks = [f"{i}\n{_srt_ts(s)} --> {_srt_ts(e)}\n{text}\n" for i, (s, e, text) in enumerate(cues, 1)]
    path.write_text("\n".join(blocks), encoding="utf-8")


def make_clip(
    src: Path,
    out_dir: Path,
    video_id: str,
    start: float,
    end: float,
    cues: list[tuple[float, float, str]] | None,
    work_dir: Path,
    crop_x: float = 0.5,
    keyframes: list[dict] | None = None,
    fit: dict | None = None,
) -> str:
    stem = f"{video_id}_{time_tag(start)}-{time_tag(end)}"
    if fit:
        pad = fit.get("pad", "blur")
        stem += f"_fit-{pad if pad != 'color' else fit['color'].lstrip('#').lower()}"
        vf = fit_filter(pad, fit.get("color", "#000000"))
    elif keyframes:
        src_w, src_h, fps = probe(src)
        keyframes = normalize_keyframes(keyframes, end - start, src_w, src_h)
        digest = hashlib.sha1(json.dumps(keyframes, sort_keys=True).encode()).hexdigest()[:6]
        stem += f"_kf{len(keyframes)}-{digest}"
        vf = keyframe_filter(keyframes, src_w, src_h, fps)
    else:
        if abs(crop_x - 0.5) > 0.005:
            stem += f"_x{round(crop_x * 100)}"
        vf = crop_scale(crop_x)
    if cues is not None:
        stem += "_cc"
    out = out_dir / f"{stem}.mp4"
    tmp = out_dir / f"{stem}.part.mp4"

    srt = None
    if cues:
        # Run ffmpeg from work_dir and reference the .srt by bare name: avoids the
        # painful escaping of Windows drive letters (C:) inside filter arguments.
        srt = work_dir / f"{stem}.srt"
        write_srt(cues, srt)
        vf += f",subtitles={srt.name}:force_style='{CAPTION_STYLE}'"

    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-ss", f"{start:.3f}", "-i", str(src), "-t", f"{end - start:.3f}",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        str(tmp),
    ]
    try:
        run(cmd, "ffmpeg", cwd=work_dir)
        tmp.replace(out)
    finally:
        tmp.unlink(missing_ok=True)
        if srt:
            srt.unlink(missing_ok=True)
    return out.name
