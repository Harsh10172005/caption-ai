"use strict";
/* Caption AI — vanilla JS editor. API key is kept only in a variable / input value, never persisted. */
const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("captionOverlay"), captionText = $("captionText");
const cueListEl = $("cueList"), statusEl = $("status");

let cues = []; // {start,end,text,words?:[{word,start,end}]}
let videoFile = null, videoURL = null, activeCueIdx = -1;
let style = { size: 28, color: "#ffffff", highlight: "#ffd60a", bg: true, pos: "bottom", karaoke: true };

const DEMO_TEXT = "Yaar suno, aaj main aapko ek aisi simple trick batane wala hoon jo literally game changer hai. Bahut log sochte hain ki consistent rehna matlab roz perfect hona, but sach ye hai ki bas roz thoda sa show up karna hi kaafi hai. Pehle main bhi har Monday full josh mein start karta tha aur Wednesday tak sab khatam. Phir maine ek chhota sa system banaya, bas fifteen minutes daily, no excuses. Aur trust me, teen hafte mein hi results dikhne lage. Agar aap bhi start karna chahte ho to comment mein likho start, main aapko poora plan bhej dunga.";
const DEMO_DURATION = 36;

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status " + kind;
  // Errors must be impossible to miss: bring the status bar to the user
  // instead of hoping they notice a line of text somewhere on the page.
  if (kind === "error" && statusEl.scrollIntoView) {
    statusEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
function guideToGenerate(flash = true) {
  // Send the user's eyes to the Advanced options panel and pulse it.
  const panel = document.getElementById("advancedPanel");
  if (!panel) return;
  panel.open = true;
  panel.scrollIntoView({ block: "center", behavior: "smooth" });
  if (flash) {
    panel.classList.remove("attention");
    void panel.offsetWidth; // restart the animation
    panel.classList.add("attention");
    setTimeout(() => panel.classList.remove("attention"), 3600);
  }
}
function requireCues(action) {
  if (cues.length) return true;
  setStatus(`⚠️ No captions yet — ${action} needs captions first. Go back and upload your video so the AI can caption it, or add captions from “Advanced options” (API key, paste a script, or Import SRT). Then try again.`, "error");
  guideToGenerate(true);
  return false;
}

/* ---------- 3-screen flow: Upload → Processing → Your captioned video ---------- */
let currentScreen = "upload";
const SCREEN_STEP = { upload: 1, processing: 2, result: 3 };
function showScreen(name) {
  currentScreen = name;
  $("screenUpload").hidden = name !== "upload";
  $("screenProcessing").hidden = name !== "processing";
  $("screenResult").hidden = name !== "result";
  document.querySelectorAll("#stepper li").forEach((li) => {
    const n = +li.dataset.step;
    li.classList.toggle("active", n === SCREEN_STEP[name]);
    li.classList.toggle("done", n < SCREEN_STEP[name]);
  });
  if (name !== "upload") $("editor").scrollIntoView({ behavior: "smooth", block: "start" });
}
function updateVideoPresence() {
  const has = !!videoFile;
  $("reselectBox").hidden = has;
  $("stageWrap").style.display = has ? "" : "none";
  if (has) $("resultFileInfo").textContent = `${videoFile.name} · ${(videoFile.size / 1048576).toFixed(1)} MB`;
}
function enterResult(opts = {}) {
  showScreen("result");
  updateVideoPresence();
  $("manualBanner").hidden = !(opts.manual && !cues.length);
  if (opts.manual) {
    $("advancedPanel").open = true;
    if (opts.focus) {
      const f = $(opts.focus);
      if (f) setTimeout(() => { try { f.focus(); } catch (e) {} }, 400);
    }
  }
}
function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}
function fmtSRT(t) {
  // Compute from TOTAL rounded milliseconds so a fraction like .9996s in
  // 00:00:59.9996 carries correctly to 00:01:00,000 instead of emitting ",1000".
  if (!isFinite(t) || t < 0) t = 0;
  const totalMs = Math.round(t * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- Video loading ---------- */
function validVideoFile(file) {
  return !!file && (/^video\//.test(file.type) || /\.(mp4|webm|mov)$/i.test(file.name));
}
function attachVideo(file) {
  videoFile = file;
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(file);
  video.src = videoURL;
  updateVideoPresence();
}
function startUploadFlow(file) {
  if (!file) return;
  if (!validVideoFile(file)) {
    setStatus("That doesn't look like a video file. Please choose an MP4 or WebM clip.", "error"); return;
  }
  if (file.size > BACKEND_MAX_MB * 1024 * 1024) {
    setStatus(`⚠️ This video is ${(file.size / 1048576).toFixed(0)} MB — over the caption server's ${BACKEND_MAX_MB} MB limit. Please trim or compress it first (in VN Editor: export at 1080p instead of 4K), then upload again.`, "error"); return;
  }
  if (jobState.active) return; // a captioning job is already running
  // A new video starts a fresh captioning session — old cues are replaced.
  cues = []; activeCueIdx = -1; renderCues(); updateOverlay(true);
  attachVideo(file);
  captureThumb(file);
  startCaptionJob(file);
}
$("videoInput").addEventListener("change", (e) => startUploadFlow(e.target.files[0]));
const dz = $("dropZone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
dz.addEventListener("drop", (e) => startUploadFlow(e.dataTransfer.files[0]));
dz.addEventListener("keydown", (e) => { if (e.key === "Enter") $("videoInput").click(); });
$("reselectInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (!validVideoFile(f)) { setStatus("That doesn't look like a video file. Please choose an MP4 or WebM clip.", "error"); return; }
  attachVideo(f);
  setStatus(`Video re-attached: ${f.name}. Your captions are loaded — preview them here, then download your captioned MP4.`, "ok");
});

video.addEventListener("loadedmetadata", () => {
  $("timeLabel").textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  // Codec sanity check AT UPLOAD TIME: a file the browser cannot decode
  // (classic case: iPhone/VN .mov or HEVC in some browsers) would otherwise
  // fail mysteriously later, at export time.
  if (!isFinite(video.duration) || video.duration === 0 || video.videoWidth === 0) {
    setStatus("⚠️ This file loaded but the browser can't decode its video (duration/size unreadable). It's probably an unsupported codec such as HEVC/.mov. Please export it as MP4 (H.264) — in VN: Share → Export → MP4 — or use the backend, which handles these files with FFmpeg.", "error");
  }
  if (cues.length) renderCues(); // re-render now that real timing is known
  updateOverlay(true);
});
video.addEventListener("error", () => {
  if (!videoFile) return;
  setStatus("⚠️ This video file can't be played by this browser — its codec isn't supported here (common with .mov / HEVC exports). Please use an MP4 (H.264) file, or send it through the backend (Auto-caption / Export MP4), which uses FFmpeg and isn't limited by browser codecs.", "error");
});
video.addEventListener("timeupdate", () => {
  $("timeLabel").textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  updateOverlay();
});
$("playPauseBtn").addEventListener("click", () => { if (video.paused) video.play(); else video.pause(); });

/* ---------- Autosave (cues + style only — NEVER the API key) ---------- */
const STORAGE_KEY = "captionAiStateV1";
let stateReady = false; // set true only after restoreState() has run at startup
function saveState() {
  // Guard: applyStyle()/renderCues() fire during initial page setup, BEFORE
  // restoreState() reads localStorage. Saving then would clobber the stored
  // captions with the empty startup state — so nothing saves until ready.
  if (!stateReady) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ cues, style })); } catch (e) { /* storage full/blocked: autosave is best-effort */ }
}
function restoreState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) { saved = null; }
  if (!saved) return;
  if (saved.style && typeof saved.style === "object") Object.assign(style, saved.style);
  // Sync style controls to the restored style.
  $("fontSize").value = style.size; $("fontSizeVal").textContent = style.size;
  $("textColor").value = style.color; $("highlightColor").value = style.highlight;
  $("bgToggle").checked = !!style.bg; $("highlightToggle").checked = !!style.karaoke;
  $("positionSelect").value = style.pos;
  if (Array.isArray(saved.cues) && saved.cues.length) {
    cues = saved.cues.filter((c) => c && isFinite(c.start) && isFinite(c.end) && typeof c.text === "string");
    renderCues(); updateOverlay(true);
    if (cues.length) {
      $("resumeRow").hidden = false;
      setStatus(`Welcome back — restored ${cues.length} autosaved caption cue${cues.length === 1 ? "" : "s"} from your last session. Resume them below, or upload a new video to start fresh. (Your API key is never saved.)`, "ok");
    }
  }
}

/* ---------- Cue model ---------- */
function splitIntoCues(words, duration) {
  // words: array of strings OR {word,start,end}; groups of ~6 words per cue
  const out = [];
  const timed = words.length && typeof words[0] === "object";
  for (let i = 0; i < words.length; i += 6) {
    const chunk = words.slice(i, i + 6);
    if (timed) {
      out.push({
        start: chunk[0].start, end: chunk[chunk.length - 1].end,
        text: chunk.map((w) => w.word).join(" ").trim(),
        words: chunk.map((w) => ({ word: w.word, start: w.start, end: w.end })),
      });
    } else {
      const start = (i / words.length) * duration, end = ((i + chunk.length) / words.length) * duration;
      const per = (end - start) / chunk.length;
      out.push({
        start, end, text: chunk.join(" "),
        words: chunk.map((w, j) => ({ word: w, start: start + j * per, end: start + (j + 1) * per })),
      });
    }
  }
  return out;
}
function setCues(newCues, msg) {
  cues = newCues.sort((a, b) => a.start - b.start);
  activeCueIdx = -1; renderCues(); updateOverlay();
  if (cues.length) { const b = $("manualBanner"); if (b) b.hidden = true; }
  if (msg) setStatus(msg, "ok");
}
function renderCues() {
  saveState();
  if (!cues.length) { cueListEl.innerHTML = '<p class="hint">No captions yet.</p>'; return; }
  cueListEl.innerHTML = "";
  cues.forEach((cue, i) => {
    const row = document.createElement("div");
    row.className = "cue" + (i === activeCueIdx ? " active" : "");
    row.innerHTML = `<span class="cue-time">${fmt(cue.start)} → ${fmt(cue.end)}</span>
      <textarea rows="2" aria-label="Caption ${i + 1}">${escapeHtml(cue.text)}</textarea>
      <button class="cue-del" title="Delete cue" type="button">×</button>`;
    row.addEventListener("click", (e) => {
      if (e.target.tagName !== "TEXTAREA" && e.target.tagName !== "BUTTON") { video.currentTime = cue.start; video.play().catch(() => {}); }
      else if (e.target.tagName !== "BUTTON") { video.currentTime = cue.start; }
    });
    row.querySelector("textarea").addEventListener("input", (e) => {
      cue.text = e.target.value;
      const words = cue.text.trim().split(/\s+/).filter(Boolean);
      const per = words.length ? (cue.end - cue.start) / words.length : 0;
      cue.words = words.map((w, j) => ({ word: w, start: cue.start + j * per, end: cue.start + (j + 1) * per }));
      updateOverlay(true); saveState();
    });
    row.querySelector(".cue-del").addEventListener("click", () => { cues.splice(i, 1); renderCues(); updateOverlay(true); });
    cueListEl.appendChild(row);
  });
}
$("addCueBtn").addEventListener("click", () => {
  const t = video.currentTime || cues.length * 3;
  cues.push({ start: t, end: t + 3, text: "New caption", words: [{ word: "New", start: t, end: t + 1.5 }, { word: "caption", start: t + 1.5, end: t + 3 }] });
  cues.sort((a, b) => a.start - b.start); renderCues();
});
$("clearCuesBtn").addEventListener("click", () => { setCues([], "Cleared all captions."); });

/* ---------- Overlay + karaoke ---------- */
function currentCueIdx() { const t = video.currentTime || 0; return cues.findIndex((c) => t >= c.start && t < c.end); }
function updateOverlay(force) {
  const idx = currentCueIdx();
  if (idx !== activeCueIdx || force) {
    activeCueIdx = idx;
    document.querySelectorAll(".cue").forEach((el, i) => el.classList.toggle("active", i === idx));
    if (idx >= 0) {
      const el = cueListEl.children[idx];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
  }
  if (idx < 0) { captionText.innerHTML = video.src ? "" : "Your captions will appear here"; return; }
  const cue = cues[idx], t = video.currentTime || 0;
  if (style.karaoke && cue.words && cue.words.length) {
    captionText.innerHTML = cue.words.map((w) =>
      `<span class="word${t >= w.start ? " hl" : ""}">${escapeHtml(w.word)}</span>`).join(" ");
  } else {
    captionText.textContent = cue.text;
  }
}
// Smooth karaoke while playing
(function loop() { if (!video.paused) updateOverlay(); requestAnimationFrame(loop); })();

/* ---------- Transcription: Gemini via the Caption AI backend ---------- */
// The browser never talks to Google directly: the video goes to our own
// backend with provider=gemini + the user's key (kept in memory only),
// the backend extracts the audio and calls Gemini, and timed cues return.
async function transcribeWithGeminiBackend(key) {
  if (!key) { setStatus("Paste your Gemini API key first — a free one comes from Google AI Studio (aistudio.google.com, then Get API key).", "error"); return; }
  if (!videoFile) { setStatus("Re-select / choose a video file first (box at the top of this screen), then transcribe.", "error"); return; }
  setStatus("Sending your video to the Caption AI server, which transcribes it with Gemini (free)… a longer video takes a little longer to upload.");
  try {
    const form = new FormData();
    form.append("file", videoFile, videoFile.name);
    form.append("provider", "gemini");
    form.append("api_key", key);
    const lang = $("languageSelect").value;
    if (lang) form.append("language", lang);
    const res = await fetch(backendBase() + "/api/transcribe", { method: "POST", body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ("Server returned " + res.status));
    }
    const newCues = Array.isArray(data.cues) ? data.cues : [];
    if (!newCues.length) throw new Error("Gemini responded, but no speech was found in this clip.");
    setCues(newCues, `Done — created ${newCues.length} caption cues from Gemini. Click any cue to check and fix words. Timing is approximate — nudge any cue that looks off.`);
    enterResult();
  } catch (err) {
    setStatus("Gemini transcription failed: " + err.message, "error");
  }
}

/* ---------- Transcription: Whisper ---------- */
$("transcribeBtn").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  const provider = ($("apiProvider") && $("apiProvider").value) || "openai";
  if (provider === "gemini") { await transcribeWithGeminiBackend(key); return; }
  const isOR = provider === "openrouter";
  const endpoint = isOR ? "https://openrouter.ai/api/v1/audio/transcriptions" : "https://api.openai.com/v1/audio/transcriptions";
  const model = isOR ? "openai/whisper-1" : "whisper-1";
  if (!key) { setStatus(`Paste your ${isOR ? "OpenRouter" : "OpenAI"} API key first — or use Auto-caption / script mode / the demo, no key needed.`, "error"); return; }
  if (!videoFile) { setStatus("Re-select / choose a video file first (box at the top of this screen), then transcribe.", "error"); return; }
  if (videoFile.size > 25 * 1024 * 1024) { setStatus("This file is over 25 MB, so the transcription API will reject it. Trim or compress the video, or paste a script instead.", "error"); return; }
  setStatus(`Sending video to ${isOR ? "OpenRouter" : "OpenAI"} Whisper… this can take a moment for longer clips.${isOR ? " Note: OpenRouter ignores the Hinglish prompt, so Hindi may come back in Devanagari script." : ""}`);
  try {
    const form = new FormData();
    form.append("file", videoFile, videoFile.name);
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    form.append("temperature", "0");
    // OpenRouter accepts `prompt` but ignores it; OpenAI uses it to bias
    // toward Roman-script Hinglish. Harmless to send to both.
    form.append("prompt", "This is Hinglish content, a mix of Hindi and English. Transcribe in Roman script (Latin alphabet), exactly as spoken, keeping Hindi words in Roman letters, for example: yaar, bahut, matlab, aaj kal, bilkul sahi hai.");
    const lang = $("languageSelect").value;
    if (lang) form.append("language", lang);
    const res = await fetch(endpoint, {
      method: "POST", headers: { Authorization: "Bearer " + key }, body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${isOR ? "OpenRouter" : "Whisper"} returned ${res.status}. ${detail.slice(0, 240)}`);
    }
    const data = await res.json();
    let newCues = [];
    if (Array.isArray(data.words) && data.words.length) {
      newCues = splitIntoCues(data.words.map((w) => ({ word: w.word, start: w.start, end: w.end })), video.duration || 0);
    } else if (Array.isArray(data.segments) && data.segments.length) {
      newCues = data.segments.map((s) => ({ start: s.start, end: s.end, text: (s.text || "").trim(), words: [] }));
      newCues.forEach((c) => { const ws = c.text.split(/\s+/).filter(Boolean); const per = ws.length ? (c.end - c.start) / ws.length : 0; c.words = ws.map((w, j) => ({ word: w, start: c.start + j * per, end: c.start + (j + 1) * per })); });
    } else if (data.text) {
      newCues = splitIntoCues(data.text.trim().split(/\s+/), video.duration || 30);
    }
    if (!newCues.length) throw new Error("Whisper responded, but no speech was found in this clip.");
    setCues(newCues, `Done — created ${newCues.length} caption cues from Whisper. Click any cue to check and fix words.`);
    enterResult();
  } catch (err) {
    setStatus("Transcription failed: " + err.message + " Check your key, connection, and file size, then try again — or use script mode.", "error");
  }
});

/* ---------- Transcription + MP4 export: Caption AI backend (no key) ---------- */
// The user never types a backend address: an explicit override (Advanced
// options / previously saved) wins; on a static host (GitHub Pages) the
// app falls back to the deployed backend; otherwise the backend is
// whatever served this page (same origin).
const DEPLOYED_BACKEND = "https://caption-ai-ukit.onrender.com";
function backendBase() {
  const field = $("backendUrl");
  const fromField = field ? field.value.trim().replace(/\/+$/, "") : "";
  if (fromField) return fromField;
  try {
    const saved = localStorage.getItem("captionAiBackendUrl");
    if (saved) return saved.trim().replace(/\/+$/, "");
  } catch (e) { /* storage blocked */ }
  if (/(^|\.)github\.io$/i.test(location.hostname || "")) return DEPLOYED_BACKEND;
  return "";
}
try {
  const savedBackend = localStorage.getItem("captionAiBackendUrl");
  if (savedBackend) $("backendUrl").value = savedBackend;
  $("backendUrl").addEventListener("change", () => {
    try { localStorage.setItem("captionAiBackendUrl", $("backendUrl").value.trim()); } catch (e) {}
  });
} catch (e) { /* storage blocked: backend field just won't persist */ }

async function parseBackendError(res) {
  try { const j = await res.json(); if (j && j.error) return j.error; } catch (e) {}
  try { return (await res.text()).slice(0, 200); } catch (e) { return "HTTP " + res.status; }
}

const BACKEND_MAX_MB = 300;
/* ---------- Automatic captioning: backend jobs with REAL progress ----------
   The processing screen is a live console for a server-side job:
   POST /api/jobs (XHR, so upload progress is real bytes %) creates the job;
   the frontend then polls GET /api/jobs/{id} every ~1.5s. The server
   measures progress from the audio itself (transcribed segment end /
   total duration, inside stage bands) — nothing here invents numbers:
   when the server reports progress_percentage=null the UI switches to
   an indeterminate display. Poll failures back off and never fail the
   job; the job_id is kept in sessionStorage so a refresh reattaches. */
const JOB_STAGES = ["uploaded", "preparing", "transcribing", "generating_captions", "preparing_editor", "completed"];
const jobState = {
  active: false, id: null, backend: undefined, timer: null, ticker: null,
  startedAt: 0, pollDelay: 1500, fails: 0, finishing: false, cancelling: false, reattached: false,
};

function jobBackend() { return jobState.backend !== undefined ? jobState.backend : backendBase(); }
function clearJobSession() {
  try {
    sessionStorage.removeItem("captionAiJobId");
    sessionStorage.removeItem("captionAiJobBackend");
    sessionStorage.removeItem("captionAiJobName");
  } catch (e) {}
}
function setJobActionsEnabled(on) {
  ["transcribeBtn", "scriptBtn", "demoBtn"].forEach((id) => { const b = $(id); if (b) b.disabled = !on; });
}

/* --- thumbnail: grab a frame locally from the picked file (display only) --- */
function captureThumb(file) {
  const img = $("procThumb");
  img.hidden = true; img.removeAttribute("src");
  try {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    let done = false;
    const finish = (dataUrl) => {
      if (done) return; done = true;
      URL.revokeObjectURL(url);
      if (dataUrl) {
        img.src = dataUrl; img.hidden = false;
        try { sessionStorage.setItem("captionAiThumb", dataUrl); } catch (e) {}
      }
    };
    const draw = () => {
      try {
        const c = document.createElement("canvas");
        const w = 180, h = Math.max(60, Math.round(w * (v.videoHeight || 320) / (v.videoWidth || 180)));
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(v, 0, 0, w, h);
        finish(c.toDataURL("image/jpeg", 0.72));
      } catch (e) { finish(null); }
    };
    v.addEventListener("loadeddata", () => {
      if (v.duration && isFinite(v.duration)) {
        v.addEventListener("seeked", draw, { once: true });
        try { v.currentTime = Math.min(0.6, v.duration / 2); } catch (e) { draw(); }
        setTimeout(draw, 900); // if 'seeked' never fires, draw the first frame
      } else draw();
    });
    v.addEventListener("error", () => finish(null));
    setTimeout(() => finish(null), 3000);
  } catch (e) { /* thumbnail is decorative — never block captioning on it */ }
}

/* --- processing console rendering --- */
const RING_C = 326.7; // 2πr for r=52
function setProcProgress(pct, indeterminate) {
  const ring = document.querySelector(".proc-ring-wrap");
  const bar = document.querySelector(".proc-bar");
  if (indeterminate) {
    ring.classList.add("indeterminate"); bar.classList.add("indeterminate");
    $("procPct").textContent = "···";
    return;
  }
  ring.classList.remove("indeterminate"); bar.classList.remove("indeterminate");
  const p = Math.max(0, Math.min(100, pct || 0));
  $("procPct").textContent = Math.round(p) + "%";
  $("procBarFill").style.width = p + "%";
  $("procRingFg").style.strokeDashoffset = String(RING_C * (1 - p / 100));
}
function setStageStates(currentStage, failedStage) {
  const cur = JOB_STAGES.indexOf(currentStage);
  document.querySelectorAll("#stageList li").forEach((li) => {
    const idx = JOB_STAGES.indexOf(li.dataset.stage);
    li.classList.toggle("done", currentStage === "completed" || idx < cur);
    li.classList.toggle("current", !failedStage && currentStage !== "completed" && idx === cur);
    li.classList.toggle("failed", li.dataset.stage === failedStage);
  });
}
function startTicker() {
  stopTicker();
  jobState.ticker = setInterval(() => {
    const el = (Date.now() - jobState.startedAt) / 1000;
    $("procElapsed").textContent = fmt(el);
    if (el > 180 && jobState.active) $("procLongNote").hidden = false;
  }, 250);
}
function stopTicker() { if (jobState.ticker) { clearInterval(jobState.ticker); jobState.ticker = null; } }
function resetProcessingUI(fileLabel) {
  $("procError").hidden = true; $("procError").classList.remove("cancelled");
  $("procSuccess").hidden = true;
  $("procLongNote").hidden = true; $("procConnNote").hidden = true;
  $("procEta").hidden = true;
  const cb = $("procCancelBtn");
  cb.hidden = false; cb.disabled = false; cb.textContent = "Cancel captioning";
  $("procMessage").textContent = "";
  $("procPhase").textContent = "Uploading your video…";
  if (fileLabel) $("fileInfo").textContent = fileLabel;
  setStageStates("uploaded");
  setProcProgress(0, false);
  $("procElapsed").textContent = "0:00";
}

/* --- job lifecycle --- */
function submitJob(file) {
  // XMLHttpRequest (not fetch) so upload progress events give the REAL
  // bytes-sent percentage for the "uploaded" stage.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", jobBackend() + "/api/jobs");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProcProgress((e.loaded / e.total) * 100, false);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300 && data && data.job_id) { resolve(data.job_id); return; }
      if (xhr.status === 404 || xhr.status === 405) {
        reject(new Error("The caption server was reached, but it doesn't offer live captioning jobs. Use the manual modes in Advanced options instead (API key or paste a script)."));
        return;
      }
      reject(new Error((data && data.error) || `The caption server returned ${xhr.status}.`));
    };
    xhr.onerror = () => reject(new Error("Could not reach the caption server. Check your connection — or use the manual modes in Advanced options (API key or paste a script)."));
    const form = new FormData();
    form.append("file", file, file.name);
    // No language field: automatic captioning always uses the server-side
    // Hinglish auto default.
    xhr.send(form);
  });
}

async function startCaptionJob(file) {
  jobState.active = true; jobState.finishing = false; jobState.cancelling = false; jobState.reattached = false;
  jobState.startedAt = Date.now(); jobState.fails = 0; jobState.pollDelay = 1500;
  jobState.backend = backendBase();
  setJobActionsEnabled(false);
  showScreen("processing");
  resetProcessingUI(`${file.name} · ${(file.size / 1048576).toFixed(1)} MB`);
  setStatus(`Captioning “${file.name}” — the AI is on it. You'll land on your captioned video automatically when it's done.`);
  startTicker();
  let jobId;
  try {
    jobId = await submitJob(file);
  } catch (err) {
    showJobFailure("uploaded", (err && err.message) || "Could not reach the caption server.");
    return;
  }
  jobState.id = jobId;
  try {
    sessionStorage.setItem("captionAiJobId", jobId);
    sessionStorage.setItem("captionAiJobBackend", jobState.backend);
    sessionStorage.setItem("captionAiJobName", file.name);
  } catch (e) {}
  setStageStates("preparing");
  $("procPhase").textContent = "Captioning your video…";
  pollJob();
}

function schedulePoll(ms) {
  clearTimeout(jobState.timer);
  jobState.timer = setTimeout(pollJob, ms);
}
async function pollJob() {
  if (!jobState.id) return;
  let job;
  try {
    const res = await fetch(jobBackend() + "/api/jobs/" + jobState.id);
    if (res.status === 404) { onJobGone(); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    job = await res.json();
    jobState.fails = 0; jobState.pollDelay = 1500;
    $("procConnNote").hidden = true;
  } catch (err) {
    // Connection loss is NOT job failure: back off and keep polling; if
    // the job finished meanwhile, the next successful poll picks it up.
    jobState.fails++;
    $("procConnNote").hidden = false;
    jobState.pollDelay = Math.min(10000, Math.max(1500, jobState.pollDelay * 2));
    schedulePoll(jobState.pollDelay);
    return;
  }
  renderJob(job);
  if (job.status === "completed") { onJobCompleted(job); return; }
  if (job.status === "failed") { onJobFailed(job); return; }
  if (job.status === "cancelled") { onJobCancelled(); return; }
  schedulePoll(1500);
}
function renderJob(job) {
  if (job.stage) setStageStates(job.stage, null);
  if (job.progress_percentage === null || job.progress_percentage === undefined) setProcProgress(0, true);
  else setProcProgress(job.progress_percentage, false);
  if (job.message) $("procMessage").textContent = job.message;
  $("procPhase").textContent = job.status === "queued" ? "Waiting to start…" : "Captioning your video…";
  if (typeof job.estimated_remaining_seconds === "number") {
    $("procEta").hidden = false;
    $("procEtaVal").textContent = fmt(job.estimated_remaining_seconds);
  } else {
    $("procEta").hidden = true;
  }
  // After a refresh-reattach, align the elapsed clock with the server's.
  if (jobState.reattached && typeof job.elapsed_seconds === "number") {
    jobState.startedAt = Date.now() - job.elapsed_seconds * 1000;
    jobState.reattached = false;
  }
}
function mapResultCues(result) {
  return (result.cues || []).map((c) => ({
    start: c.start, end: c.end, text: c.text,
    words: (c.words && c.words.length) ? c.words : (() => {
      const ws = (c.text || "").trim().split(/\s+/).filter(Boolean);
      const per = ws.length ? (c.end - c.start) / ws.length : 0;
      return ws.map((w, j) => ({ word: w, start: c.start + j * per, end: c.start + (j + 1) * per }));
    })(),
  }));
}
function onJobCompleted(job) {
  if (jobState.finishing) return;
  jobState.finishing = true;
  stopTicker();
  if (typeof job.elapsed_seconds === "number") $("procElapsed").textContent = fmt(job.elapsed_seconds);
  setStageStates("completed", null);
  setProcProgress(100, false);
  $("procMessage").textContent = "";
  $("procPhase").textContent = "Done!";
  $("procCancelBtn").hidden = true;
  $("procSuccess").hidden = false;
  const result = job.result || {};
  setTimeout(() => finishToEditor(result), 1200);
}
function finishToEditor(result) {
  const mapped = mapResultCues(result || {});
  jobState.active = false; jobState.id = null;
  clearJobSession();
  setJobActionsEnabled(true);
  if (mapped.length) {
    setCues(mapped, `Auto-caption done — created ${mapped.length} cues${result.language ? ` (detected language: ${result.language})` : ""}. Check the words, fix any mistakes, style them, then download your captioned MP4.`);
  } else {
    setStatus("Captioning finished, but no captions came back. Try again, or add captions from Advanced options.", "error");
  }
  enterResult();
}
function showJobFailure(stage, message) {
  stopTicker();
  clearTimeout(jobState.timer);
  jobState.active = false;
  setJobActionsEnabled(true);
  setStageStates(stage || "transcribing", stage || "transcribing");
  $("procPhase").textContent = "Captioning didn't finish";
  $("procCancelBtn").hidden = true;
  const box = $("procError");
  box.hidden = false; box.classList.remove("cancelled");
  $("procKeyBtn").hidden = false; $("procScriptBtn").hidden = false;
  $("procErrorMsg").textContent = "⚠️ " + message;
  // Retry re-submits the SAME File object — only possible while it's
  // still held in this page (not after a refresh).
  $("procRetryBtn").hidden = !videoFile;
  setStatus("Auto-caption didn't finish: " + message, "error");
}
function onJobFailed(job) {
  const err = job.error || {};
  showJobFailure(err.stage || job.stage || "transcribing",
    err.message || job.message || "Captioning failed for an unknown reason.");
}
function onJobCancelled() {
  stopTicker();
  clearTimeout(jobState.timer);
  jobState.active = false;
  setJobActionsEnabled(true);
  $("procPhase").textContent = "Captioning cancelled";
  $("procCancelBtn").hidden = true;
  const box = $("procError");
  box.hidden = false; box.classList.add("cancelled");
  $("procErrorMsg").textContent = "Captioning was cancelled. Your video wasn't changed — try again whenever you're ready.";
  $("procRetryBtn").hidden = !videoFile;
  $("procKeyBtn").hidden = false; $("procScriptBtn").hidden = false;
  setStatus("Captioning cancelled — nothing was changed.");
}
function onJobGone() {
  stopTicker();
  clearTimeout(jobState.timer);
  jobState.active = false; jobState.id = null;
  setJobActionsEnabled(true);
  clearJobSession();
  setStatus("That captioning job is gone — finished jobs are kept for about 30 minutes. Please upload your video again.", "error");
  if (cues.length) enterResult(); else showScreen("upload");
}

/* --- processing screen actions --- */
$("procCancelBtn").addEventListener("click", async () => {
  if (!jobState.id || jobState.cancelling) return;
  jobState.cancelling = true;
  const btn = $("procCancelBtn");
  btn.disabled = true; btn.textContent = "Cancelling…";
  try { await fetch(jobBackend() + "/api/jobs/" + jobState.id + "/cancel", { method: "POST" }); } catch (e) {}
  clearTimeout(jobState.timer);
  pollJob(); // the poll loop observes the cancelled status and shows it
});
$("procRetryBtn").addEventListener("click", () => {
  if (!videoFile || jobState.active) return;
  clearJobSession();
  startCaptionJob(videoFile); // same File object — the user does NOT re-pick
});
function leaveJobForManual(focus) {
  // Deliberately leaving the job flow: stop ALL timers/polls so a late
  // poll can never yank the user out of manual mode, and drop the stored
  // job so a refresh doesn't reattach to it either.
  stopTicker();
  clearTimeout(jobState.timer);
  jobState.active = false; jobState.id = null;
  clearJobSession();
  setJobActionsEnabled(true);
  enterResult({ manual: true, focus });
}
$("procKeyBtn").addEventListener("click", () => leaveJobForManual("apiKey"));
$("procKeyBtnTop").addEventListener("click", () => leaveJobForManual("apiKey"));
$("procScriptBtn").addEventListener("click", () => leaveJobForManual("scriptInput"));
$("procStartOverBtn").addEventListener("click", resetAll);
$("newVideoBtn").addEventListener("click", resetAll);
$("resumeBtn").addEventListener("click", () => {
  enterResult();
  setStatus("Your saved captions are loaded. Re-select the same video file (box at the top) to preview them and export the captioned MP4.", "ok");
});
$("uploadAdvBtn").addEventListener("click", () => enterResult({ manual: true }));

function resetAll() {
  stopTicker();
  clearTimeout(jobState.timer);
  jobState.active = false; jobState.id = null; jobState.finishing = false;
  clearJobSession();
  try { sessionStorage.removeItem("captionAiThumb"); } catch (e) {}
  setJobActionsEnabled(true);
  videoFile = null;
  if (videoURL) { URL.revokeObjectURL(videoURL); videoURL = null; }
  video.removeAttribute("src");
  try { video.load(); } catch (e) {}
  cues = []; activeCueIdx = -1; renderCues(); updateOverlay(true);
  $("videoInput").value = "";
  const ri = $("reselectInput"); if (ri) ri.value = "";
  $("manualBanner").hidden = true;
  $("resumeRow").hidden = true;
  setStatus("Ready — upload a video and we'll add AI captions to it. You'll only get it back with captions on it.");
  showScreen("upload");
}

/* --- refresh reattach: resume polling the job stored in sessionStorage --- */
function tryReattach() {
  let id = null, name = "", thumb = null;
  try {
    id = sessionStorage.getItem("captionAiJobId");
    jobState.backend = sessionStorage.getItem("captionAiJobBackend");
    name = sessionStorage.getItem("captionAiJobName") || "";
    thumb = sessionStorage.getItem("captionAiThumb");
  } catch (e) {}
  if (!id) { jobState.backend = undefined; return; }
  jobState.id = id;
  jobState.active = true; jobState.reattached = true;
  jobState.startedAt = Date.now(); jobState.fails = 0; jobState.pollDelay = 1500;
  setJobActionsEnabled(false);
  showScreen("processing");
  resetProcessingUI(name ? `${name} · reconnected after refresh` : "Your video · reconnected after refresh");
  if (thumb) { const img = $("procThumb"); img.src = thumb; img.hidden = false; }
  $("procPhase").textContent = "Reconnecting to your captioning job…";
  startTicker();
  pollJob();
}

$("exportMp4BackendBtn").addEventListener("click", async () => {
  if (!videoFile) {
    setStatus("Re-select your video file first (the box at the top of this screen) — the captioned MP4 is made from your original clip, and browsers can't restore the file automatically.", "error");
    const rb = $("reselectBox");
    rb.scrollIntoView({ block: "center", behavior: "smooth" });
    rb.classList.remove("attention"); void rb.offsetWidth; rb.classList.add("attention");
    setTimeout(() => rb.classList.remove("attention"), 3600);
    return;
  }
  if (videoFile.size > BACKEND_MAX_MB * 1024 * 1024) { setStatus(`⚠️ This video is ${(videoFile.size / 1048576).toFixed(0)} MB — over the backend's ${BACKEND_MAX_MB} MB limit. Please trim or compress it first.`, "error"); return; }
  if (!requireCues("Backend MP4 export")) return;
  const base = backendBase();
  const btn = $("exportMp4BackendBtn"); btn.disabled = true;
  setStatus("Sending video + captions to the backend to burn in… you'll get a captioned MP4 back.");
  try {
    const form = new FormData();
    form.append("file", videoFile, videoFile.name);
    form.append("srt", toSRT(cues));
    form.append("fontsize", String(Math.max(14, Math.round(style.size * 0.85))));
    form.append("color", style.color);
    form.append("position", style.pos);
    const res = await fetch(base + "/api/burn", { method: "POST", body: form });
    if (!res.ok) throw new Error(await parseBackendError(res));
    download("captioned-video.mp4", await res.blob());
    setStatus("Done — downloaded captioned-video.mp4 with burned-in captions, made by the backend.", "ok");
  } catch (err) {
    setStatus("Backend MP4 export failed: " + (err && err.message ? err.message : err) + " — the caption server may be unreachable (check the override in Advanced options), or use the browser WebM export instead.", "error");
  } finally { btn.disabled = false; }
});

/* ---------- Transcription: script fallback + demo ---------- */
function captionsFromText(text, label) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) { setStatus("Paste some text first.", "error"); return; }
  const duration = (video.duration && isFinite(video.duration)) ? video.duration : Math.max(10, words.length / 2.5);
  setCues(splitIntoCues(words, duration), `${label}: created ${Math.ceil(words.length / 6)} cues timed across ${fmt(duration)}. ${video.duration ? "" : "Tip: load a video first for exact timing."}`);
  enterResult();
}
$("scriptBtn").addEventListener("click", () => captionsFromText($("scriptInput").value, "Script mode"));
function loadDemo() {
  $("scriptInput").value = DEMO_TEXT;
  if (!video.duration || !isFinite(video.duration)) {
    // No video: build cues against demo duration so overlay/editor still work via playhead simulation is not needed;
    // cues use DEMO_DURATION and will sync once any video of similar length is loaded.
    setCues(splitIntoCues(DEMO_TEXT.split(/\s+/), DEMO_DURATION), "Demo loaded — Hinglish captions are ready in the editor. Upload a talking-head video any time to caption the real thing, edit the words, and try the styles.");
    enterResult();
  } else {
    captionsFromText(DEMO_TEXT, "Demo loaded");
  }
}
$("demoBtn").addEventListener("click", loadDemo);
$("heroDemoBtn").addEventListener("click", loadDemo);

/* ---------- Styles ---------- */
function applyStyle() {
  document.documentElement.style.setProperty("--cap-size", style.size + "px");
  document.documentElement.style.setProperty("--cap-color", style.color);
  document.documentElement.style.setProperty("--cap-highlight", style.highlight);
  overlay.className = "caption-overlay pos-" + style.pos + (style.bg ? " with-bg" : "");
  updateOverlay(true); saveState();
}
const presets = {
  "clean": { size: 26, color: "#ffffff", highlight: "#ffffff", bg: true },
  "bold-yellow": { size: 32, color: "#ffffff", highlight: "#ffd60a", bg: true },
  "high-energy": { size: 36, color: "#ffd60a", highlight: "#ff4d8d", bg: true },
  "minimal": { size: 22, color: "#ffffff", highlight: "#a5d8ff", bg: false },
};
document.querySelectorAll(".preset").forEach((b) => b.addEventListener("click", () => {
  Object.assign(style, presets[b.dataset.preset]); $("fontSize").value = style.size; $("fontSizeVal").textContent = style.size;
  $("textColor").value = style.color; $("highlightColor").value = style.highlight; $("bgToggle").checked = style.bg; applyStyle();
  setStatus(`Applied the “${b.textContent.trim()}” caption style.`, "ok");
}));
$("fontSize").addEventListener("input", (e) => { style.size = +e.target.value; $("fontSizeVal").textContent = style.size; applyStyle(); });
$("textColor").addEventListener("input", (e) => { style.color = e.target.value; applyStyle(); });
$("highlightColor").addEventListener("input", (e) => { style.highlight = e.target.value; applyStyle(); });
$("bgToggle").addEventListener("change", (e) => { style.bg = e.target.checked; applyStyle(); });
$("highlightToggle").addEventListener("change", (e) => { style.karaoke = e.target.checked; applyStyle(); });
$("positionSelect").addEventListener("change", (e) => { style.pos = e.target.value; applyStyle(); });
applyStyle();
restoreState();
stateReady = true;

/* ---------- Import: SRT ---------- */
function parseSrtTime(ts) {
  const m = String(ts).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, "0")) / 1000;
}
function parseSRT(text) {
  const blocks = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const parts = lines[ti].split("-->");
    const start = parseSrtTime(parts[0]), end = parseSrtTime((parts[1] || "").trim().split(/\s+/)[0]);
    if (start === null || end === null || end <= start) continue;
    const cueText = lines.slice(ti + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!cueText) continue;
    const ws = cueText.split(/\s+/).filter(Boolean);
    const per = (end - start) / ws.length;
    out.push({ start, end, text: cueText, words: ws.map((w, j) => ({ word: w, start: start + j * per, end: start + (j + 1) * per })) });
  }
  return out.sort((a, b) => a.start - b.start);
}
$("srtInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow re-importing the same file
  if (!file) return;
  try {
    const imported = parseSRT(await file.text());
    if (!imported.length) { setStatus(`Couldn't find any valid caption cues in ${file.name}. Check that it's a standard .srt file.`, "error"); return; }
    setCues(imported, `Imported ${imported.length} caption cues from ${file.name}. Edit, restyle, preview, or burn them into your video.`);
    enterResult();
  } catch (err) {
    setStatus("SRT import failed: " + err.message, "error");
  }
});

/* ---------- Export: SRT ---------- */
function toSRT(list) {
  return list.map((c, i) => `${i + 1}\n${fmtSRT(c.start)} --> ${fmtSRT(c.end)}\n${c.text.trim()}\n`).join("\n");
}
$("exportSrtBtn").addEventListener("click", () => {
  if (!requireCues("SRT export")) return;
  download("captions.srt", new Blob([toSRT(cues)], { type: "text/plain;charset=utf-8" }));
  setStatus("Downloaded captions.srt", "ok");
});
$("exportWordSrtBtn").addEventListener("click", () => {
  if (!requireCues("Word-level SRT export")) return;
  const wordCues = [];
  cues.forEach((c) => {
    if (c.words && c.words.length) c.words.forEach((w) => wordCues.push({ start: w.start, end: w.end, text: w.word }));
    else wordCues.push(c);
  });
  download("captions-words.srt", new Blob([toSRT(wordCues)], { type: "text/plain;charset=utf-8" }));
  setStatus("Downloaded word-level SRT — one cue per word, great for karaoke-style edits.", "ok");
});

/* ---------- Export: burned-in video (canvas + MediaRecorder) ---------- */
// A MediaElementSource can be created only ONCE per <video> element — creating
// it again throws InvalidStateError. So the audio graph is built lazily on the
// first export and REUSED for every later export in this session. It is never
// closed: closing the AudioContext would leave the element silent and break
// audio on any second export.
let _audioCtx = null, _audioDest = null;
function ensureAudioGraph() {
  if (_audioCtx && _audioDest) return _audioDest;
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = _audioCtx.createMediaElementSource(video);
    _audioDest = _audioCtx.createMediaStreamDestination();
    srcNode.connect(_audioDest); srcNode.connect(_audioCtx.destination);
    return _audioDest;
  } catch (e) { return null; /* audio is best-effort; video-only export still works */ }
}
function seekToStart() {
  // Seek to 0 and wait for 'seeked' BEFORE starting the recorder/player, so the
  // first frames (and first caption) are never missed.
  return new Promise((resolve) => {
    if (!video.duration || Math.abs(video.currentTime) < 0.01) { resolve(); return; }
    const onSeeked = () => { video.removeEventListener("seeked", onSeeked); resolve(); };
    video.addEventListener("seeked", onSeeked);
    try { video.currentTime = 0; } catch (e) { video.removeEventListener("seeked", onSeeked); resolve(); }
    setTimeout(() => { video.removeEventListener("seeked", onSeeked); resolve(); }, 1500); // never hang the export on a missing event
  });
}
$("exportVideoBtn").addEventListener("click", async () => {
  if (!video.src) { setStatus("Load a video first — in-browser export needs a real clip to render.", "error"); return; }
  if (!requireCues("Video export")) return;
  // Detect an unsupported export environment UP FRONT, with a specific way
  // out — never let this fail silently or mid-render. The classic case is
  // Safari, where canvas.captureStream / MediaRecorder video recording are
  // missing or unreliable; the backend MP4 export is the answer there.
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent || "");
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    setStatus(isSafari
      ? "⚠️ In-browser video export isn't supported in Safari — Safari can't record the captioned video this way. Use “Export MP4 (backend)” instead (the server renders a real MP4), or open this page in Chrome for the in-browser export."
      : "⚠️ In-browser video export isn't supported in this browser (no MediaRecorder/captureStream). Use “Export MP4 (backend)” instead, or open this page in Chrome.", "error");
    return;
  }
  const btn = $("exportVideoBtn"); btn.disabled = true;
  const progress = $("exportProgress"); progress.hidden = false; progress.value = 0;
  const progressText = $("exportProgressText"); progressText.hidden = false; progressText.textContent = "Preparing export…";
  const cancelBtn = $("exportCancelBtn"); cancelBtn.hidden = false;
  let exportCancelled = false;
  cancelBtn.onclick = () => { exportCancelled = true; try { video.pause(); } catch (e) {} };
  setStatus("Exporting… the video will play through in real time while captions are drawn onto it. Keep this tab open — you can cancel any time.");
  let rec = null;
  let elapsedTimer = setInterval(() => {
    if (video.duration) progressText.textContent = `Exporting… ${fmt(video.currentTime)} of ${fmt(video.duration)} (${Math.round((video.currentTime / video.duration) * 100)}%) — rendering in real time.`;
  }, 500);
  try {
    video.pause();
    await seekToStart();
    const W = video.videoWidth || 720, H = video.videoHeight || 1280;
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(30);
    // Include original audio via the single, reused audio graph (if available).
    const audioDest = ensureAudioGraph();
    if (audioDest) {
      if (_audioCtx.state === "suspended") { try { await _audioCtx.resume(); } catch (e) {} }
      audioDest.stream.getAudioTracks().forEach((t) => { try { stream.addTrack(t); } catch (e) {} });
    }

    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 5_000_000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    // Register 'ended' BEFORE play() — registering after play() races short clips.
    const ended = new Promise((r) => video.addEventListener("ended", r, { once: true }));

    const draw = () => {
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
      if (video.readyState >= 2) ctx.drawImage(video, 0, 0, W, H);
      const idx = currentCueIdx();
      if (idx >= 0) {
        const cue = cues[idx], t = video.currentTime;
        const scale = W / 380; // overlay was designed around ~380px wide stage
        const fs = Math.max(18, style.size * scale * 0.9);
        ctx.font = `800 ${fs}px system-ui, Arial, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const words = (style.karaoke && cue.words && cue.words.length)
          ? cue.words.map((w) => ({ txt: w.word, hl: t >= w.start })) : cue.text.split(/\s+/).map((w) => ({ txt: w, hl: false }));
        // Wrap into lines of ~5 words
        const lines = [];
        for (let i = 0; i < words.length; i += 5) lines.push(words.slice(i, i + 5));
        const lineH = fs * 1.3;
        let y = style.pos === "top" ? H * 0.10 : style.pos === "middle" ? H * 0.5 - (lines.length * lineH) / 2 : H * 0.88 - lines.length * lineH;
        lines.forEach((line) => {
          const widths = line.map((w) => ctx.measureText(w.txt).width);
          const gap = fs * 0.28, total = widths.reduce((a, b) => a + b, 0) + gap * (line.length - 1);
          if (style.bg) { ctx.fillStyle = "rgba(0,0,0,0.72)"; roundRect(ctx, W / 2 - total / 2 - 12, y - 6, total + 24, lineH, 10); ctx.fill(); }
          let x = W / 2 - total / 2;
          line.forEach((w, j) => {
            ctx.fillStyle = w.hl ? style.highlight : style.color;
            ctx.fillText(w.txt, x + widths[j] / 2, y + lineH / 2);
            x += widths[j] + gap;
          });
          y += lineH;
        });
      }
      progress.value = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      if (!video.ended && !video.paused) requestAnimationFrame(draw);
    };
    function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

    // Start the recorder BEFORE play() so no opening frames/audio are missed,
    // then play, then draw. ('ended' was already registered above.)
    rec.start(250);
    try {
      await video.play();
    } catch (playErr) {
      // Gesture/autoplay activation can be lost across the awaits above
      // (notably on longer clips), so play() can reject even though the
      // user clicked Export. Fail cleanly with the exact remedy instead
      // of hanging forever on a video that never plays.
      try { if (rec.state !== "inactive") rec.stop(); } catch (e) {}
      throw new Error("the browser refused to start playback (" + (playErr.name || "blocked") + "). Press Play on the video once so it starts, pause it, then press Export again — or use “Export MP4 (backend)”, which doesn't need playback at all.");
    }
    draw();
    // Wait for the video to end OR for a cancel — a paused video never
    // fires 'ended', so without this the cancel button would hang the export.
    await Promise.race([ended, new Promise((r) => {
      const iv = setInterval(() => { if (exportCancelled) { clearInterval(iv); r(); } }, 250);
    })]);
    if (rec.state !== "inactive") rec.stop();
    await stopped;
    if (exportCancelled) {
      setStatus("Export cancelled — nothing was downloaded. Your video and captions are unchanged.", "error");
      return;
    }
    // NOTE: the shared AudioContext is deliberately NOT closed here — it is
    // reused by the next export, and closing it would break second exports.
    download("captioned-video.webm", new Blob(chunks, { type: "video/webm" }));
    setStatus("Done — downloaded captioned-video.webm with burned-in captions. You can export again in this session; audio is included every time.", "ok");
  } catch (err) {
    try { if (rec && rec.state !== "inactive") rec.stop(); } catch (e) {}
    setStatus("Video export failed: " + err.message + " Try Chrome, or export the SRT files instead.", "error");
  } finally {
    clearInterval(elapsedTimer);
    btn.disabled = false; progress.hidden = true; progressText.hidden = true; cancelBtn.hidden = true; cancelBtn.onclick = null;
  }
});

/* ---------- Startup: land on Upload — or reattach to a running job ---------- */
showScreen("upload");
tryReattach();
