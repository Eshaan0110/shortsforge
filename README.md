# shortsforge

**Turn long YouTube videos into vertical Shorts, Reels and TikToks, on your own computer.**

shortsforge is a free, local web app: paste a YouTube link, pick a moment, and export a
1080×1920 clip with optional burned-in captions. Everything runs on your machine. There are
no accounts, no uploads to anyone's cloud, no subscriptions and no paid APIs.

---

## Features

- **YouTube in, vertical clip out.** Paste a link, preview it, export 1080×1920 H.264 MP4s.
- **Three ways to frame the shot:**
  - **FIXED**: one 9:16 crop for the whole clip (left / center / right, a slider, or drag the box on the player).
  - **CUSTOM · KEYFRAMES**: the crop moves during the clip. Put keyframes on a timeline (e.g. host on the left
    for 0:00–0:12, then the guest on the right) and it slides or cuts between them. Per-keyframe zoom,
    smooth or snap motion, and a live preview on the player.
  - **FIT**: no cropping. The whole frame sits inside 9:16 with a blurred background, black bars or a colour of your choice.
- **Captions.** Speech-to-text runs locally ([faster-whisper](https://github.com/SYSTRAN/faster-whisper)) on just the
  range you're clipping, then burns in short, punchy white captions with a black outline.
- **Transcript navigation.** Transcribe a range, then click a line to set the start and Shift+click to set the end.
- **Batch mode.** Paste a list of time ranges and render them all in one go, with progress.
- **Clip gallery.** Preview, download or delete every clip you've made.
- **Clear errors.** If a download or render fails you see the real reason, not a generic error.

## Install and run (Windows): 3 steps, no typing

1. **Download.** On this page click the green **Code** button → **Download ZIP**.
   *(Or, if you use git: `git clone https://github.com/Eshaan0110/shortsforge.git`)*
2. **Unzip.** Right-click the downloaded ZIP → **Extract All** → **Extract**.
3. **Start.** Open the extracted `shortsforge` folder and double-click **`start.bat`**.

That's it. `start.bat` checks everything it needs. If something is missing it asks
**"Install … now? [Y/N]"**: press **Y**, and it installs it for you:

| It may install | What it's for |
|---|---|
| **uv** | runs the app and sets up Python automatically (you do *not* need to install Python) |
| **ffmpeg** | cuts and renders the videos |

Then your browser opens **http://localhost:8765** by itself.

> **"Windows protected your PC"?** Windows shows this for scripts downloaded from the internet.
> Click **More info** → **Run anyway**.

> **Keep the black window open** while you use the app. Closing it stops shortsforge.

### What to expect the first time

| When | What happens | How long |
|---|---|---|
| First double-click | Installs uv/ffmpeg if needed, then downloads Python and the app's packages | 2–5 minutes |
| First time you use captions or transcription | Downloads a speech model (~145 MB) once | 1–3 minutes |
| Every time after that | Starts in a few seconds | — |

### Every time after

Double-click **`start.bat`**, use the app in your browser, and close the black window when you're done.
Double-clicking it while the app is already running just opens it in your browser again.

## Install and run (macOS / Linux)

```bash
git clone https://github.com/Eshaan0110/shortsforge.git
cd shortsforge
./start.sh
```

Like `start.bat`, it offers to install **uv** and **ffmpeg** if they're missing (ffmpeg through
Homebrew, apt, dnf, pacman or zypper; on macOS without Homebrew, install it from [brew.sh](https://brew.sh) first).
Your browser opens **http://localhost:8765**. Keep the terminal open; press **Ctrl+C** to stop.

## Uninstall

Delete the `shortsforge` folder. That removes the app, downloaded videos, clips and the speech model.
If `start.bat` installed them and you don't need them for anything else, you can also remove the tools:
`winget uninstall astral-sh.uv` and `winget uninstall Gyan.FFmpeg`.

## How to use it

1. **Fetch.** Paste a YouTube URL and click **FETCH**. The video downloads (up to 1080p) into `cache/`.
   Fetching the same video again is instant.
2. **Choose the moment.** Type **START** and **END** (`MM:SS`, `H:MM:SS` or seconds), or play the video and
   press the **◷** buttons to use the current time.
3. **Optional: transcript.** Press **TRANSCRIBE START–END** to see what's said in that range. Click a line
   to set the start, Shift+click a line to set the end.
4. **Frame it.** Pick **FIXED**, **CUSTOM · KEYFRAMES** or **FIT** under *Crop* (see below). The yellow box on
   the player shows exactly what the clip will keep.
5. **Captions.** Tick **Burn captions into clip** to add subtitles. If the range isn't transcribed yet, it's
   transcribed automatically when you generate.
6. **GENERATE CLIP.** The finished clip appears under **YOUR CLIPS** with a download button and is saved in `output/`.

### Keyframes (two people in one shot)

1. Set START/END, then choose **CUSTOM · KEYFRAMES**. A timeline appears under the player.
2. Move the playhead (click the timeline or scrub the video) and **drag the 9:16 box** onto whoever is talking.
   This adds a keyframe at that moment. You can also press **+** to add one at the playhead.
3. Repeat for each change of speaker.
4. Click a dot to edit it: **zoom**, and **SMOOTH** (slide to the next keyframe) or **SNAP** (hold, then cut).
   Drag a dot to retime it. Shift-click or right-click a dot to delete it.
5. Play or scrub the video to preview the motion, then generate.

Keyframe times are relative to the clip start, so changing START moves the whole animation with it.

### Batch mode

Open **BATCH MODE**, paste one range per line, then **GENERATE ALL**. The crop and caption settings
above are used for every clip.

```
0:10-0:25
1:02 1:30
75, 90
```

## Configuration

Set these as environment variables before running `start.bat` / `start.sh`:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8765` | Port the app listens on. |
| `HOST` | `127.0.0.1` | Interface to bind. Keep the default unless you understand the risk: the app has no login, so `0.0.0.0` lets anyone on your network use it. |
| `SHORTSFORGE_WHISPER_MODEL` | `base` | Speech model: `tiny` (fastest), `base`, `small`, `medium`, `large-v3` (most accurate, slowest). |
| `SHORTSFORGE_YES` | not set | Set to `1` to answer **yes** to every install question automatically. |
| `SHORTSFORGE_NO_BROWSER` | not set | Set to `1` to stop the launcher from opening the browser. |

Windows example: `set PORT=9000` then `start.bat`. macOS/Linux: `PORT=9000 ./start.sh`.

## Updating

```bash
git pull
```

Then start the app as usual; new dependencies install automatically. YouTube changes often, so if
downloads start failing, update the downloader:

```bash
uv lock --upgrade-package yt-dlp
uv sync
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Page shows "Backend: unreachable" or "page opened as a file" | The black start window was closed. Double-click `start.bat` again. Always use **http://localhost:8765**, not the `frontend/index.html` file. |
| "Windows protected your PC" | Click **More info** → **Run anyway**. |
| The automatic install of uv or ffmpeg failed | Install it yourself (`winget install astral-sh.uv` / `winget install Gyan.FFmpeg`, or from [docs.astral.sh/uv](https://docs.astral.sh/uv/) and [gyan.dev/ffmpeg](https://www.gyan.dev/ffmpeg/builds/)), then double-click `start.bat` again. |
| `address already in use` | Another program uses port 8765. Close it, or run `set PORT=9000` and then `start.bat`. |
| Download fails with "Sign in to confirm you're not a bot" or missing formats | Update yt-dlp (see *Updating*). Installing a JavaScript runtime also helps: `winget install DenoLand.Deno`. |
| Transcription stuck on "downloading Whisper model" | The model download resumes where it left off. Restart the app if it stalls. |
| Page looks old after updating | Hard refresh: **Ctrl + Shift + R**. |
| Clip won't delete | It may still be playing in the page. Pause it and try again. |

## Disk usage

- `cache/` holds downloaded videos (≈ 50–150 MB per 10 min of 1080p), transcripts and the speech model.
  Delete old videos from it whenever you like; they re-download if needed.
- `output/` holds your finished clips (≈ 5–15 MB each).

Both folders are created automatically and are ignored by git.

## How it works

```
Browser (frontend/: HTML + CSS + vanilla JS, no build step)
   │  JSON over HTTP
FastAPI server (backend/)
   ├── downloader.py   yt-dlp → cache/<id>.mp4   (cached; skipped if already downloaded)
   ├── transcriber.py  ffmpeg audio → faster-whisper (CPU, int8), one background worker,
   │                   results cached per range as JSON
   ├── clipper.py      ffmpeg: cut → crop / keyframed reframe / fit+pad → captions → H.264 1080×1920
   └── main.py         API routes + static file serving
```

- External tools (`yt-dlp`, `ffmpeg`) run as subprocesses. When they fail, their stderr is returned to the UI.
- Keyframed crops are rendered with per-frame ffmpeg expressions: a static crop when nothing moves, and the
  `perspective` filter (sub-pixel, smooth) when the crop pans or zooms.
- There's no database. The file system is the source of truth, so restarting the app loses nothing but
  in-progress jobs.

### API

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/health` | `{"ok": true}` |
| POST | `/api/fetch` | `{url}` → `{video_id, filename, duration, title}` |
| POST | `/api/clip` | `{video_id, start, end, captions?, crop_mode: "fixed"\|"custom"\|"fit", crop_x?, keyframes?, pad?, pad_color?}` → `{filename, start, end}` |
| POST | `/api/batch` | `{video_id, ranges: [{start, end}], captions?, …crop settings}` → `{job_id}` |
| GET | `/api/batch/{job_id}` | progress and per-clip results |
| POST | `/api/transcribe` | `{video_id, start, end}`: transcribe just that range in the background |
| GET | `/api/transcript/{video_id}?start=&end=` | `{status: "done", segments}` or `{status: "queued" \| "downloading_model" \| "processing" \| "error" \| "missing"}` |
| GET | `/api/clips` | clips in `output/` |
| DELETE | `/api/clips/{filename}` | delete a clip |

Keyframe format (custom crop): `{"time": 0.0, "x": 0.1, "y": 0.0, "width": 0.32, "height": 1.0, "ease": "smooth"}`.
`time` is seconds from the clip start, and the box is given as fractions (0–1) of the source frame.

Tool failures return `{"detail": {"error": "...", "stderr": "..."}}`.

### Project layout

```
backend/     FastAPI app, downloader, transcriber, clipper
frontend/    index.html, style.css, app.js
start.bat    Windows launcher (installs missing tools, then starts the app)
start.sh     macOS / Linux launcher
scripts/     helper used by start.bat to fetch a portable ffmpeg if winget isn't available
.tools/      portable tools downloaded by start.bat                 (created only if needed)
cache/       downloaded videos, transcripts, speech model   (created at runtime)
output/      rendered clips                                 (created at runtime)
```

For development with auto-reload: `uv run uvicorn backend.main:app --reload --port 8765`.

## Roadmap

- Split-screen layouts (two speakers, screen recording + webcam, gameplay + webcam)
- Caption styles: fonts, colours, word-by-word highlight, emojis, saved style presets
- Hook title and logo/watermark overlays
- Silence removal
- Automatic speaker tracking (classical face detection, no cloud)

## Responsible use

shortsforge downloads videos with yt-dlp. Only clip content you own or have permission to use, and
respect YouTube's Terms of Service and the copyright of the original creators.

## License

[MIT](LICENSE): free to use, modify and share, including commercially. Keep the copyright notice.
