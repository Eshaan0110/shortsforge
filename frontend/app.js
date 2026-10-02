const $ = (id) => document.getElementById(id);
const player = $("player");
const LAST_VIDEO_KEY = "shortsforge:lastVideo";

const state = {
  video: null,
  segments: [],
  transcriptTimer: null,
  cropX: 0.5, // FIXED mode: 0 = left edge, 0.5 = center, 1 = right edge
  cropMode: "fixed", // "fixed" | "custom"
  keyframes: [], // CUSTOM mode, sorted by time (s from clip start)
  selectedKf: null,
  pad: "blur", // FIT mode: "blur" | "black" | "color"
  padColor: "#7c3aed",
};

// ---------- icons (inline SVG, stroke-based, currentColor) ----------

const svg = (body) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_PLAY =
  '<svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="#fff" stroke="#0a0a0a" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const ICON_DOWNLOAD = svg('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>');
const ICON_TRASH = svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>');
const ICON_CHECK = svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>');
const ICON_ALERT = svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.5v.01"/>');

// ---------- helpers ----------

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  let data = null;
  try { data = await r.json(); } catch { /* non-JSON body */ }
  if (!r.ok) {
    const d = data && data.detail;
    let msg = `HTTP ${r.status}`;
    if (typeof d === "string") msg = d;
    else if (Array.isArray(d)) msg = d.map((x) => x.msg).join("; ");
    else if (d && d.error) msg = d.error;
    const err = new Error(msg);
    err.stderr = (d && d.stderr) || "";
    throw err;
  }
  return data;
}

function setStatus(el, kind, message, stderr = "") {
  el.innerHTML = "";
  if (!message) return;
  const line = document.createElement("div");
  line.className = kind === "busy" ? "busy" : kind; // "ok" | "err" | "busy" | ""
  if (message instanceof Node) line.append(message);
  else line.textContent = message;
  el.append(line);
  if (stderr) {
    const pre = document.createElement("pre");
    pre.textContent = stderr;
    el.append(pre);
  }
}

function showError(el, err) {
  setStatus(el, "err", err.message || String(err), err.stderr);
}

/** Bottom-right toast. kind: "success" | "error". Auto-dismisses after 4s. */
function toast(kind, message) {
  const host = $("toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML = kind === "error" ? ICON_ALERT : ICON_CHECK;
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);
  host.append(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 250);
  }, 4000);
}

/** Swap a button's label for "WORKING..." + hazard tape (and restore it). */
function setBusy(btn, busy) {
  if (busy) {
    if (!btn.classList.contains("is-loading")) btn.dataset.label = btn.innerHTML;
    btn.textContent = "WORKING...";
    btn.classList.add("is-loading");
    btn.disabled = true;
  } else {
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    btn.classList.remove("is-loading");
    btn.disabled = false;
  }
}

/** "MM:SS", "H:MM:SS", "12.5" -> seconds. NaN if invalid. */
function parseTime(v) {
  v = String(v).trim();
  if (!v) return NaN;
  const parts = v.split(":");
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return NaN;
    total = total * 60 + parseFloat(p);
  }
  return total;
}

/** seconds -> "M:SS" or "M:SS.s" */
function fmtTime(t) {
  const tenths = Math.round(Math.max(0, t) * 10);
  const m = Math.floor(tenths / 600);
  const rest = tenths - m * 600;
  let s = rest % 10 === 0 ? String(rest / 10) : (rest / 10).toFixed(1);
  if (rest < 100) s = "0" + s;
  return `${m}:${s}`;
}

function fmtBytes(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- health ----------

(function checkHealth() {
  const el = $("health");
  if (location.protocol === "file:") {
    el.textContent = "page opened as a file — open http://localhost:8765 instead";
    el.className = "err";
    return;
  }
  fetch("/api/health", { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json())
    .then((d) => { el.textContent = d.ok ? "ok" : "unexpected response"; el.className = d.ok ? "ok" : "err"; })
    .catch((e) => { el.textContent = `unreachable (${e.message})`; el.className = "err"; });
})();

// ---------- fetch ----------

$("fetch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("fetch-btn");
  const status = $("fetch-status");
  const card = $("fetch-card");
  setBusy(btn, true);
  card.classList.add("is-loading");
  setStatus(status, "busy", "Fetching… a new video downloads first, which can take a minute.");
  try {
    const v = await api("/api/fetch", { method: "POST", body: JSON.stringify({ url: $("url").value }) });
    loadVideo(v);
    setStatus(status, "", "");
    toast("success", `Loaded “${v.title}”`);
  } catch (err) {
    showError(status, err);
    toast("error", err.message || "Fetch failed");
  } finally {
    setBusy(btn, false);
    card.classList.remove("is-loading");
  }
});

function loadVideo(v) {
  state.video = v;
  state.segments = [];
  try { localStorage.setItem(LAST_VIDEO_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
  $("workspace").hidden = false;
  $("video-title").textContent = v.title;
  const dur = $("video-duration");
  dur.textContent = v.duration ? fmtTime(v.duration) : "";
  dur.hidden = !v.duration;
  player.src = `/cache/${encodeURIComponent(v.filename)}`;
  $("start").value = "";
  $("end").value = "";
  resetCrop();
  setStatus($("clip-status"), "", "");
  renderTranscript();
  updateRangeUI();
  loadCachedTranscript();
}

// ---------- transcript ----------
// Only clip ranges are transcribed: on demand (TRANSCRIBE START–END) or automatically on
// Generate with captions. A whole-video transcript from older versions is still shown if cached.

function setTranscriptStatus(text, kind = "muted") {
  const el = $("transcript-status");
  el.textContent = text;
  el.className = kind;
}

function showSegments(segments, label) {
  state.segments = segments;
  renderTranscript();
  updateRangeUI();
  setTranscriptStatus(`${label} · ${segments.length} line${segments.length === 1 ? "" : "s"}`);
}

async function loadCachedTranscript() {
  clearTimeout(state.transcriptTimer);
  const vid = state.video && state.video.video_id;
  if (!vid) return;
  try {
    const t = await api(`/api/transcript/${encodeURIComponent(vid)}`);
    if (!state.video || state.video.video_id !== vid) return;
    if (t.status === "done") showSegments(t.segments, "whole video");
    else setTranscriptStatus("not transcribed yet");
  } catch (err) {
    setTranscriptStatus(`error: ${err.message}`, "err");
  }
}

/** Poll one range's transcript until it's done; shows progress meanwhile. */
async function pollRangeTranscript(vid, start, end) {
  clearTimeout(state.transcriptTimer);
  const label = `${fmtTime(start)}–${fmtTime(end)}`;
  try {
    const t = await api(`/api/transcript/${encodeURIComponent(vid)}?start=${start}&end=${end}`);
    if (!state.video || state.video.video_id !== vid) return;
    if (t.status === "done") {
      showSegments(t.segments, label);
      $("transcribe-btn").disabled = false;
      return;
    }
    if (t.status === "error" || t.status === "missing") {
      setTranscriptStatus(t.status === "error" ? `failed: ${t.error}` : "not started", "err");
      $("transcribe-btn").disabled = false;
      return;
    }
    const pct = `${Math.round((t.progress || 0) * 100)}%`;
    setTranscriptStatus(
      t.status === "processing" ? `transcribing ${label}… ${pct}`
      : t.status === "downloading_model" ? `downloading Whisper model (one-time, ${fmtBytes(t.total_bytes || 0)})… ${pct}`
      : "queued…",
      "muted busy",
    );
  } catch (err) {
    setTranscriptStatus(`error: ${err.message}`, "err");
  }
  state.transcriptTimer = setTimeout(() => pollRangeTranscript(vid, start, end), 1500);
}

$("transcribe-btn").addEventListener("click", async () => {
  if (!state.video) return;
  const start = parseTime($("start").value);
  const end = parseTime($("end").value);
  if (isNaN(start) || isNaN(end) || end <= start) {
    toast("error", "Set START and END first — only that range gets transcribed");
    return;
  }
  $("transcribe-btn").disabled = true;
  try {
    const r = await api("/api/transcribe", {
      method: "POST",
      body: JSON.stringify({ video_id: state.video.video_id, start, end }),
    });
    pollRangeTranscript(state.video.video_id, r.start, r.end);
  } catch (err) {
    setTranscriptStatus(`error: ${err.message}`, "err");
    $("transcribe-btn").disabled = false;
  }
});

function renderTranscript() {
  const ol = $("transcript");
  ol.innerHTML = "";
  state.segments.forEach((s, i) => {
    const li = document.createElement("li");
    li.dataset.i = i;
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = fmtTime(s.start);
    const tx = document.createElement("span");
    tx.textContent = s.text;
    li.append(ts, tx);
    ol.append(li);
  });
}

$("transcript").addEventListener("mousedown", (e) => { if (e.shiftKey) e.preventDefault(); });
$("transcript").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  const seg = state.segments[li.dataset.i];
  if (e.shiftKey) {
    $("end").value = fmtTime(seg.end);
  } else {
    $("start").value = fmtTime(seg.start);
    player.currentTime = seg.start;
  }
  updateRangeUI();
});

player.addEventListener("timeupdate", () => {
  const t = player.currentTime;
  document.querySelectorAll("#transcript li").forEach((li) => {
    const s = state.segments[li.dataset.i];
    li.classList.toggle("active", t >= s.start && t < s.end);
  });
});

// ---------- clip range ----------

function updateRangeUI() {
  const s = parseTime($("start").value);
  const e = parseTime($("end").value);
  const ok = !isNaN(s) && !isNaN(e) && e > s;
  $("clip-length").textContent = ok ? `${(e - s).toFixed(1)}s clip` : "";
  document.querySelectorAll("#transcript li").forEach((li) => {
    const seg = state.segments[li.dataset.i];
    li.classList.toggle("in-range", ok && seg.end > s && seg.start < e);
  });
  // The keyframe timeline is scaled to the clip range.
  renderTimeline();
  layoutCropGuide();
}

$("start").addEventListener("input", updateRangeUI);
$("end").addEventListener("input", updateRangeUI);

document.querySelectorAll("[data-now]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $(btn.dataset.now).value = fmtTime(player.currentTime);
    updateRangeUI();
  });
});

$("clip-btn").addEventListener("click", async () => {
  const status = $("clip-status");
  const start = parseTime($("start").value);
  const end = parseTime($("end").value);
  if (isNaN(start) || isNaN(end)) return setStatus(status, "err", "Enter start and end as MM:SS or seconds.");
  if (end <= start) return setStatus(status, "err", "End must be after start.");

  const btn = $("clip-btn");
  setBusy(btn, true);
  const captions = $("captions").checked;
  setStatus(status, "busy", captions
    ? `Transcribing ${fmtTime(start)}–${fmtTime(end)} (if needed) + rendering ${(end - start).toFixed(1)}s clip…`
    : `Rendering ${(end - start).toFixed(1)}s vertical clip…`);
  try {
    const res = await api("/api/clip", {
      method: "POST",
      body: JSON.stringify({
        video_id: state.video.video_id, start, end, captions: $("captions").checked, ...cropPayload(),
      }),
    });
    const a = document.createElement("a");
    a.href = `/output/${encodeURIComponent(res.filename)}`;
    a.download = res.filename;
    a.className = "mono";
    a.textContent = res.filename;
    const frag = document.createDocumentFragment();
    frag.append("Created ", a);
    setStatus(status, "ok", frag);
    toast("success", "Clip ready");
    refreshClips(res.filename);
    if (captions) pollRangeTranscript(state.video.video_id, res.start, res.end); // show what was burned in
  } catch (err) {
    showError(status, err);
    toast("error", err.message || "Clip failed");
  } finally {
    setBusy(btn, false);
  }
});

// ---------- crop ----------
// A crop box is { x, y, width, height } in 0..1 fractions of the source frame (always 9:16 in pixels).
// FIXED mode: one box, positioned by state.cropX. CUSTOM mode: keyframes
// { time (s from clip start), x, y, width, height, ease: "smooth" | "snap" } interpolated over time —
// the same math clipper.build_crop_expr() runs in ffmpeg.

const KF_SNAP = 0.05; // seconds: "playhead is on this keyframe"

/** Where the picture actually sits inside the <video> element (it may be letterboxed). */
function videoRect() {
  const w = player.clientWidth;
  const h = player.clientHeight;
  const vw = player.videoWidth;
  const vh = player.videoHeight;
  if (!w || !h || !vw || !vh) return null;
  const scale = Math.min(w / vw, h / vh);
  return { left: (w - vw * scale) / 2, top: (h - vh * scale) / 2, width: vw * scale, height: vh * scale };
}

/** Largest 9:16 box, as fractions of the frame — mirrors the ffmpeg crop in clipper.py. */
function baseBox() {
  const vw = player.videoWidth;
  const vh = player.videoHeight;
  if (!vw || !vh) return null;
  return { width: Math.min(1, (vh * 9) / 16 / vw), height: Math.min(1, (vw * 16) / 9 / vh) };
}

function fixedCrop() {
  const b = baseBox();
  return b && { x: (1 - b.width) * state.cropX, y: (1 - b.height) / 2, width: b.width, height: b.height };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Clip range from the START/END inputs, else the whole video. */
function clipRange() {
  const s = parseTime($("start").value);
  const e = parseTime($("end").value);
  if (!isNaN(s) && !isNaN(e) && e > s) return { start: s, dur: e - s, fromInputs: true };
  return { start: 0, dur: player.duration || (state.video && state.video.duration) || 0, fromInputs: false };
}

const relTime = () => player.currentTime - clipRange().start;

/** Interpolated crop at t seconds from clip start (same rules as the backend). */
function cropAt(t) {
  const k = state.keyframes;
  if (!k.length) return null;
  if (t <= k[0].time) return { ...k[0] };
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (t < b.time) {
      if (a.ease === "snap" || b.time - a.time < 1e-6) return { ...a };
      const f = (t - a.time) / (b.time - a.time);
      const lerp = (key) => a[key] + (b[key] - a[key]) * f;
      return { x: lerp("x"), y: lerp("y"), width: lerp("width"), height: lerp("height") };
    }
  }
  return { ...k[k.length - 1] };
}

function displayedCrop() {
  if (state.cropMode === "fit") return null; // whole frame is kept: no crop box
  if (state.cropMode === "custom" && state.keyframes.length) return cropAt(relTime());
  return fixedCrop();
}

// --- fixed mode ---

function setCrop(x) {
  state.cropX = clamp(Math.round(x * 100) / 100, 0, 1);
  const pct = Math.round(state.cropX * 100);
  $("crop-x").value = pct;
  document.querySelectorAll("[data-crop]").forEach((b) => {
    b.setAttribute("aria-pressed", String(Math.abs(parseFloat(b.dataset.crop) - state.cropX) < 0.001));
  });
  updateCropSticker();
  layoutCropGuide();
}

function updateCropSticker() {
  const pct = Math.round(state.cropX * 100);
  $("crop-value").textContent = state.cropMode === "custom"
    ? `${state.keyframes.length} KEYFRAME${state.keyframes.length === 1 ? "" : "S"}`
    : state.cropMode === "fit" ? `FIT · ${state.pad === "color" ? state.padColor.toUpperCase() : state.pad.toUpperCase()}`
    : pct === 0 ? "LEFT" : pct === 50 ? "CENTER" : pct === 100 ? "RIGHT" : `${pct}%`;
}

// --- fit mode ---

function setPad(pad) {
  state.pad = pad;
  document.querySelectorAll("[data-pad]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pad === pad)));
  $("pad-color").disabled = pad !== "color";
  updateCropSticker();
}

document.querySelectorAll("[data-pad]").forEach((b) => b.addEventListener("click", () => setPad(b.dataset.pad)));
$("pad-color").addEventListener("input", (e) => {
  state.padColor = e.target.value;
  $("pad-color-value").textContent = e.target.value.toUpperCase();
  updateCropSticker();
});
setPad(state.pad);

// --- custom (keyframe) mode ---

function setCropMode(mode) {
  state.cropMode = mode;
  document.querySelectorAll("[data-crop-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cropMode === mode)));
  $("crop-fixed").hidden = mode !== "fixed";
  $("crop-fit").hidden = mode !== "fit";
  $("crop-custom-hint").hidden = mode !== "custom";
  $("kf-panel").hidden = mode !== "custom";
  if (mode === "custom") ensureKeyframes();
  renderTimeline();
  updateCropSticker();
  layoutCropGuide();
}

/** Seed the timeline with one keyframe at the clip start, using the current fixed position. */
function ensureKeyframes() {
  if (state.keyframes.length) return;
  const c = fixedCrop();
  if (!c) return; // video metadata not loaded yet; retried on loadedmetadata
  state.keyframes = [{ time: 0, ...c, ease: "smooth" }];
}

function sortKeyframes() {
  state.keyframes.sort((a, b) => a.time - b.time);
}

/** Select a keyframe and park the playhead on it, so the box shows (and edits) exactly it. */
function selectKeyframe(kf) {
  state.selectedKf = kf;
  if (kf) {
    const t = clipRange().start + kf.time;
    if (Math.abs(player.currentTime - t) > 0.01) player.currentTime = t;
  }
  renderTimeline();
  layoutCropGuide();
}

function addKeyframeAt(t) {
  const near = state.keyframes.find((k) => Math.abs(k.time - t) < KF_SNAP);
  if (near) { selectKeyframe(near); return near; }
  const c = cropAt(t) || fixedCrop();
  const prev = [...state.keyframes].reverse().find((k) => k.time <= t);
  const kf = { time: Math.round(t * 100) / 100, x: c.x, y: c.y, width: c.width, height: c.height, ease: prev ? prev.ease : "smooth" };
  state.keyframes.push(kf);
  sortKeyframes();
  selectKeyframe(kf);
  updateCropSticker();
  return kf;
}

function deleteKeyframe(kf) {
  if (state.keyframes.length <= 1 || kf.time === 0) {
    toast("error", state.keyframes.length <= 1 ? "At least one keyframe is required" : "The start keyframe can't be deleted");
    return;
  }
  state.keyframes = state.keyframes.filter((k) => k !== kf);
  if (state.selectedKf === kf) state.selectedKf = null;
  renderTimeline();
  updateCropSticker();
  layoutCropGuide();
}

/** Playhead inside the clip range? Returns the relative time or null (with a toast). */
function playheadInRange() {
  const t = relTime();
  const { dur } = clipRange();
  if (!dur || t < -0.01 || t > dur + 0.01) {
    toast("error", "Move the playhead inside the clip range (START–END) first");
    return null;
  }
  return clamp(t, 0, dur);
}

function renderTimeline() {
  if (state.cropMode !== "custom") return;
  const lane = $("kf-lane");
  const range = clipRange();
  lane.querySelectorAll(".kf-dot").forEach((d) => d.remove());
  $("kf-range").textContent = range.dur
    ? `${fmtTime(range.start)} → ${fmtTime(range.start + range.dur)}${range.fromInputs ? "" : " · whole video (set START/END)"}`
    : "";

  state.keyframes.forEach((kf, i) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "kf-dot"
      + (kf === state.selectedKf ? " is-selected" : "")
      + (kf.ease === "snap" ? " is-snap" : "")
      + (range.dur && kf.time > range.dur ? " is-outside" : "");
    dot.style.left = `${range.dur ? clamp(kf.time / range.dur, 0, 1) * 100 : 0}%`;
    dot.title = `Keyframe ${i + 1} · +${fmtTime(kf.time)} · ${kf.ease}${kf.time === 0 ? " · start" : ""}`;
    dot.setAttribute("aria-label", `${dot.title}. Click to edit, shift-click to delete.`);
    bindDot(dot, kf);
    lane.append(dot);
  });
  updatePlayhead();
  renderKfEditor();
}

function bindDot(dot, kf) {
  dot.addEventListener("contextmenu", (e) => { e.preventDefault(); deleteKeyframe(kf); });
  dot.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.shiftKey) { deleteKeyframe(kf); return; }
    dot.setPointerCapture(e.pointerId);
    const laneRect = $("kf-lane").getBoundingClientRect();
    const { dur } = clipRange();
    const startX = e.clientX;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 4) return;
      if (kf.time === 0 && !moved) return; // the start keyframe is pinned to 0
      moved = true;
      dot.classList.add("is-dragging");
      kf.time = Math.round(clamp(((ev.clientX - laneRect.left) / laneRect.width) * dur, 0.01, dur) * 100) / 100;
      dot.style.left = `${(kf.time / dur) * 100}%`;
    };
    const up = () => {
      dot.removeEventListener("pointermove", move);
      dot.removeEventListener("pointerup", up);
      dot.removeEventListener("pointercancel", up);
      if (moved) {
        // Dropped on another keyframe's time: the dragged one replaces it.
        state.keyframes = state.keyframes.filter((k) => k === kf || Math.abs(k.time - kf.time) >= 0.01);
        sortKeyframes();
      }
      selectKeyframe(kf);
      updateCropSticker();
    };
    dot.addEventListener("pointermove", move);
    dot.addEventListener("pointerup", up);
    dot.addEventListener("pointercancel", up);
  });
  dot.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteKeyframe(kf); }
  });
}

function updatePlayhead() {
  const ph = $("kf-playhead");
  const { dur } = clipRange();
  const t = relTime();
  ph.hidden = !(dur && t >= 0 && t <= dur);
  if (!ph.hidden) ph.style.left = `${(t / dur) * 100}%`;
}

function renderKfEditor() {
  const kf = state.selectedKf;
  $("kf-editor").hidden = !kf;
  $("kf-empty").hidden = !!kf;
  if (!kf) return;
  const i = state.keyframes.indexOf(kf);
  $("kf-selected").textContent = `KF ${i + 1} · +${fmtTime(kf.time)}`;
  document.querySelectorAll("[data-ease]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ease === kf.ease)));
  const b = baseBox();
  const zoom = b ? b.height / kf.height : 1;
  $("kf-zoom").value = Math.round(zoom * 100);
  $("kf-zoom-value").textContent = `${zoom.toFixed(1)}×`;
  $("kf-delete").disabled = kf.time === 0 || state.keyframes.length <= 1;
}

// Clicking the empty track scrubs the playhead.
$("kf-track").addEventListener("pointerdown", (e) => {
  const { start, dur } = clipRange();
  if (!dur) return;
  const r = $("kf-lane").getBoundingClientRect();
  player.currentTime = start + clamp((e.clientX - r.left) / r.width, 0, 1) * dur;
});

$("kf-add").addEventListener("click", () => {
  if (state.cropMode !== "custom") return;
  ensureKeyframes();
  const t = playheadInRange();
  if (t !== null) addKeyframeAt(t);
});

document.querySelectorAll("[data-ease]").forEach((b) => {
  b.addEventListener("click", () => {
    if (!state.selectedKf) return;
    state.selectedKf.ease = b.dataset.ease;
    renderTimeline();
    layoutCropGuide();
  });
});

$("kf-zoom").addEventListener("input", (e) => {
  const kf = state.selectedKf;
  const b = baseBox();
  if (!kf || !b) return;
  const z = e.target.value / 100;
  const cx = kf.x + kf.width / 2;
  const cy = kf.y + kf.height / 2;
  kf.width = b.width / z;
  kf.height = b.height / z;
  kf.x = clamp(cx - kf.width / 2, 0, 1 - kf.width);
  kf.y = clamp(cy - kf.height / 2, 0, 1 - kf.height);
  $("kf-zoom-value").textContent = `${z.toFixed(1)}×`;
  layoutCropGuide();
});

$("kf-delete").addEventListener("click", () => { if (state.selectedKf) deleteKeyframe(state.selectedKf); });

document.querySelectorAll("[data-crop-mode]").forEach((b) => b.addEventListener("click", () => setCropMode(b.dataset.cropMode)));

/** Payload for /api/clip and /api/batch. */
function cropPayload() {
  if (state.cropMode === "custom" && state.keyframes.length) {
    const r4 = (v) => Math.round(v * 10000) / 10000;
    return {
      crop_mode: "custom",
      keyframes: state.keyframes.map((k) => ({
        time: Math.round(k.time * 1000) / 1000, x: r4(k.x), y: r4(k.y), width: r4(k.width), height: r4(k.height), ease: k.ease,
      })),
    };
  }
  if (state.cropMode === "fit") return { crop_mode: "fit", pad: state.pad, pad_color: state.padColor };
  return { crop_mode: "fixed", crop_x: state.cropX };
}

function resetCrop() {
  state.keyframes = [];
  state.selectedKf = null;
  setCrop(0.5);
  setCropMode(state.cropMode);
}

// --- overlay ---

function layoutCropGuide() {
  const guide = $("crop-guide");
  const r = videoRect();
  const b = baseBox();

  // Fixed mode: already-vertical sources have nothing to move sideways.
  const canSlide = !b || b.width < 0.999;
  $("crop-x").disabled = !canSlide;
  document.querySelectorAll("[data-crop]").forEach((btn) => { btn.disabled = !canSlide; });
  $("crop-hint").textContent = canSlide
    ? "Drag the 9:16 box on the player, or use the presets / slider."
    : "This video is already vertical — nothing to crop sideways (CUSTOM mode can still zoom).";

  const c = displayedCrop();
  guide.hidden = !(r && c && $("crop-guide-toggle").checked);
  if (guide.hidden) return;
  Object.assign(guide.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  Object.assign($("crop-box").style, {
    left: `${c.x * r.width}px`,
    top: `${c.y * r.height}px`,
    width: `${c.width * r.width}px`,
    height: `${c.height * r.height}px`,
    bottom: "auto",
  });
}

/** Keep the overlay + timeline in sync with the playhead; deselect when the playhead leaves a keyframe. */
function onPlayheadMove() {
  if (state.cropMode !== "custom") return;
  if (state.selectedKf && Math.abs(relTime() - state.selectedKf.time) > KF_SNAP) {
    state.selectedKf = null;
    renderTimeline();
  }
  updatePlayhead();
  layoutCropGuide();
}

let previewFrame = 0;
function previewLoop() {
  onPlayheadMove();
  if (!player.paused && !player.ended) previewFrame = requestAnimationFrame(previewLoop);
}
player.addEventListener("play", () => { cancelAnimationFrame(previewFrame); previewLoop(); });
player.addEventListener("seeked", onPlayheadMove);
player.addEventListener("timeupdate", () => { if (player.paused) onPlayheadMove(); });

$("crop-x").addEventListener("input", (e) => setCrop(e.target.value / 100));
document.querySelectorAll("[data-crop]").forEach((b) => {
  b.addEventListener("click", () => setCrop(parseFloat(b.dataset.crop)));
});
$("crop-guide-toggle").addEventListener("change", layoutCropGuide);
player.addEventListener("loadedmetadata", () => {
  if (state.cropMode === "custom") { ensureKeyframes(); renderTimeline(); updateCropSticker(); }
  layoutCropGuide();
});
new ResizeObserver(layoutCropGuide).observe(player);

// --- dragging the box ---

const cropHandle = $("crop-handle");

/** In CUSTOM mode, the keyframe being edited: the selected one, or a new one at the playhead. */
function keyframeForEdit() {
  ensureKeyframes();
  if (state.selectedKf) return state.selectedKf;
  const t = playheadInRange();
  return t === null ? null : addKeyframeAt(t);
}

cropHandle.addEventListener("pointerdown", (e) => {
  const r = videoRect();
  const b = baseBox();
  if (!r || !b) return;
  e.preventDefault();

  let move;
  if (state.cropMode === "custom") {
    const kf = keyframeForEdit();
    if (!kf) return;
    const start = { x: kf.x, y: kf.y, cx: e.clientX, cy: e.clientY };
    move = (ev) => {
      kf.x = clamp(start.x + (ev.clientX - start.cx) / r.width, 0, 1 - kf.width);
      kf.y = clamp(start.y + (ev.clientY - start.cy) / r.height, 0, 1 - kf.height);
      layoutCropGuide();
    };
  } else {
    const slack = (1 - b.width) * r.width;
    if (slack <= 1) return;
    const startX = e.clientX;
    const startCrop = state.cropX;
    move = (ev) => setCrop(startCrop + (ev.clientX - startX) / slack);
  }

  cropHandle.setPointerCapture(e.pointerId);
  $("crop-guide").classList.add("is-dragging");
  const up = () => {
    cropHandle.removeEventListener("pointermove", move);
    cropHandle.removeEventListener("pointerup", up);
    cropHandle.removeEventListener("pointercancel", up);
    $("crop-guide").classList.remove("is-dragging");
  };
  cropHandle.addEventListener("pointermove", move);
  cropHandle.addEventListener("pointerup", up);
  cropHandle.addEventListener("pointercancel", up);
});

cropHandle.addEventListener("keydown", (e) => {
  if (state.cropMode === "custom") {
    const step = e.shiftKey ? 0.05 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const kf = keyframeForEdit();
    if (!kf) return;
    kf.x = clamp(kf.x + d[0], 0, 1 - kf.width);
    kf.y = clamp(kf.y + d[1], 0, 1 - kf.height);
    layoutCropGuide();
    return;
  }
  const step = e.shiftKey ? 0.1 : 0.02;
  const next = { ArrowLeft: state.cropX - step, ArrowRight: state.cropX + step, Home: 0, End: 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  setCrop(next);
});

// ---------- batch ----------

function parseRanges(text) {
  const ranges = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const parts = line.trim().split(/\s*[-–—,]\s*|\s+/).filter(Boolean);
    const [s, e] = parts.map(parseTime);
    if (parts.length !== 2 || isNaN(s) || isNaN(e)) errors.push(`line ${i + 1}: can't read “${line.trim()}”`);
    else if (e <= s) errors.push(`line ${i + 1}: end must be after start`);
    else ranges.push({ start: s, end: e });
  });
  return { ranges, errors };
}

$("batch-btn").addEventListener("click", async () => {
  const status = $("batch-status");
  const { ranges, errors } = parseRanges($("batch-ranges").value);
  if (errors.length) return setStatus(status, "err", errors.join(" · "));
  if (!ranges.length) return setStatus(status, "err", "Add at least one range.");

  const btn = $("batch-btn");
  const bar = $("batch-progress");
  const label = $("batch-label");
  const list = $("batch-results");
  setBusy(btn, true);
  list.innerHTML = "";
  bar.hidden = false;
  bar.max = ranges.length;
  bar.value = 0;
  setStatus(status, "", "");

  try {
    const { job_id } = await api("/api/batch", {
      method: "POST",
      body: JSON.stringify({
        video_id: state.video.video_id, ranges, captions: $("captions").checked, ...cropPayload(),
      }),
    });
    let job;
    do {
      await new Promise((r) => setTimeout(r, 1000));
      job = await api(`/api/batch/${job_id}`);
      bar.value = job.done;
      label.textContent = `${job.done} / ${job.total}`;
      renderBatchResults(job.results);
    } while (job.status !== "done");
    const failed = job.results.filter((r) => r.error).length;
    const summary = failed ? `${job.total - failed} done, ${failed} failed` : `All ${job.total} clips done`;
    setStatus(status, failed ? "err" : "ok", summary);
    toast(failed ? "error" : "success", `Batch: ${summary}`);
    refreshClips();
  } catch (err) {
    showError(status, err);
    toast("error", err.message || "Batch failed");
  } finally {
    setBusy(btn, false);
  }
});

function renderBatchResults(results) {
  const list = $("batch-results");
  list.innerHTML = "";
  for (const r of results) {
    const li = document.createElement("li");
    const range = `${fmtTime(parseTime(r.start))}–${fmtTime(parseTime(r.end))}: `;
    if (r.error) {
      li.className = "err";
      li.textContent = range + r.error;
      if (r.stderr) li.title = r.stderr;
    } else {
      const a = document.createElement("a");
      a.href = `/output/${encodeURIComponent(r.filename)}`;
      a.download = r.filename;
      a.textContent = r.filename;
      li.append(range, a);
    }
    list.append(li);
  }
}

// ---------- clips gallery ----------

function clipCard(c, index, highlight) {
  const url = `/output/${encodeURIComponent(c.filename)}`;
  const li = document.createElement("li");
  li.className = "clip-card" + (c.filename === highlight ? " is-fresh" : "");
  li.style.setProperty("--i", Math.min(index, 8));
  li.innerHTML = `
    <div class="clip-thumb">
      <video preload="metadata" playsinline></video>
      <button class="clip-play" type="button" aria-label="Play clip">${ICON_PLAY}</button>
      <span class="sticker clip-duration"></span>
    </div>
    <div class="clip-meta">
      <span class="clip-name"></span>
      <div class="clip-row">
        <span class="clip-size"></span>
        <div class="clip-actions">
          <button class="icon-btn clip-delete" type="button" aria-label="Delete clip" title="Delete clip">${ICON_TRASH}</button>
          <a class="btn btn-secondary btn-sm clip-download">${ICON_DOWNLOAD}DOWNLOAD</a>
        </div>
      </div>
    </div>`;

  const video = li.querySelector("video");
  video.src = `${url}#t=0.1`; // media fragment -> first real frame as the poster
  video.addEventListener("loadedmetadata", () => {
    if (isFinite(video.duration)) li.querySelector(".clip-duration").textContent = fmtTime(video.duration);
  });
  li.querySelector(".clip-play").addEventListener("click", () => {
    li.classList.add("is-playing");
    video.controls = true;
    video.currentTime = 0;
    video.play();
  });

  const name = li.querySelector(".clip-name");
  name.textContent = c.filename;
  name.title = c.filename;
  li.querySelector(".clip-size").textContent = fmtBytes(c.size);
  const a = li.querySelector(".clip-download");
  a.href = url;
  a.download = c.filename;

  const del = li.querySelector(".clip-delete");
  let confirmTimer = null;
  del.addEventListener("click", async () => {
    // Two-step: first click arms the button, second click (within 3s) deletes.
    if (!del.classList.contains("is-confirming")) {
      del.classList.add("is-confirming");
      del.innerHTML = "DELETE?";
      del.setAttribute("aria-label", "Click again to confirm delete");
      confirmTimer = setTimeout(() => {
        del.classList.remove("is-confirming");
        del.innerHTML = ICON_TRASH;
        del.setAttribute("aria-label", "Delete clip");
      }, 3000);
      return;
    }
    clearTimeout(confirmTimer);
    del.disabled = true;
    // Release the file handle first: Windows can't delete a file that's being streamed.
    video.pause();
    video.removeAttribute("src");
    video.load();
    try {
      await api(`/api/clips/${encodeURIComponent(c.filename)}`, { method: "DELETE" });
      li.classList.add("is-removing");
      setTimeout(() => {
        li.remove();
        $("clips-empty").hidden = $("clips").children.length > 0;
      }, 200);
      toast("success", "Clip deleted");
    } catch (err) {
      toast("error", err.message || "Delete failed");
      video.src = `${url}#t=0.1`;
      del.disabled = false;
      del.classList.remove("is-confirming");
      del.innerHTML = ICON_TRASH;
    }
  });
  return li;
}

async function refreshClips(highlight) {
  const ul = $("clips");
  const empty = $("clips-empty");
  try {
    const clips = await api("/api/clips");
    ul.innerHTML = "";
    clips.forEach((c, i) => ul.append(clipCard(c, i, highlight)));
    empty.hidden = clips.length > 0;
  } catch (err) {
    ul.innerHTML = "";
    empty.hidden = true;
    const li = document.createElement("li");
    li.className = "clip-card err";
    li.textContent = `Couldn't list clips: ${err.message}`;
    ul.append(li);
  }
}

$("refresh-clips").addEventListener("click", () => refreshClips());

// ---------- boot ----------

refreshClips();
try {
  const saved = JSON.parse(localStorage.getItem(LAST_VIDEO_KEY) || "null");
  if (saved && saved.video_id) loadVideo(saved);
} catch { /* ignore bad/unavailable storage */ }
