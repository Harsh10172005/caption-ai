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
  // Send the user's eyes to the "Generate captions" panel and pulse it.
  const panel = document.getElementById("transcribePanel");
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
  setStatus(`⚠️ No captions yet — ${action} needs captions first. Step 1: generate them in the “1 · Generate captions” panel (Auto-caption, API key, paste a script, or Import SRT). Then try again.`, "error");
  guideToGenerate(true);
  return false;
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
function loadVideoFile(file) {
  if (!file) return;
  if (!/^video\//.test(file.type) && !/\.(mp4|webm|mov)$/i.test(file.name)) {
    setStatus("That doesn't look like a video file. Please choose an MP4 or WebM clip.", "error"); return;
  }
  videoFile = file;
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(file);
  video.src = videoURL;
  const mb = (file.size / 1048576).toFixed(1);
  $("fileInfo").textContent = `${file.name} · ${mb} MB`;
  if (file.size > 25 * 1024 * 1024) {
    setStatus(`✅ Video loaded: ${file.name} (${mb} MB). NEXT STEP → generate captions in the panel below: press “Auto-caption my video”. (Note: at ${mb} MB the API-key mode is over its 25 MB limit — Auto-caption via the backend accepts videos up to 300 MB.)`, "ok");
  } else {
    setStatus(`✅ Video loaded: ${file.name} (${mb} MB). NEXT STEP → generate captions in the panel below: press “Auto-caption my video” (backend, no key), or use an API key / paste a script. Nothing is captioned yet — exporting before this step won't work.`, "ok");
  }
  guideToGenerate(true);
}
$("videoInput").addEventListener("change", (e) => loadVideoFile(e.target.files[0]));
const dz = $("dropZone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
dz.addEventListener("drop", (e) => loadVideoFile(e.dataTransfer.files[0]));
dz.addEventListener("keydown", (e) => { if (e.key === "Enter") $("videoInput").click(); });

video.addEventListener("loadedmetadata", () => {
  $("timeLabel").textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  // Codec sanity check AT UPLOAD TIME: a file the browser cannot decode
  // (classic case: iPhone/VN .mov or HEVC in some browsers) would otherwise
  // fail mysteriously later, at export time.
  if (!isFinite(video.duration) || video.duration === 0 || video.videoWidth === 0) {
    setStatus("⚠️ This file loaded but the browser can't decode its video (duration/size unreadable). It's probably an unsupported codec such as HEVC/.mov. Please export it as MP4 (H.264) — in VN: Share → Export → MP4 — or use the backend, which handles these files with FFmpeg.", "error");
  }
  if (cues.length && !videoFile) return;
  if (cues.length) renderCues(); // re-time script cues if they were made before load
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
    if (cues.length) setStatus(`Restored ${cues.length} autosaved caption cue${cues.length === 1 ? "" : "s"} from your last session. Your captions and style autosave in this browser as you work (your API key is never saved).`, "ok");
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

/* ---------- Transcription: Whisper ---------- */
$("transcribeBtn").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  const provider = ($("apiProvider") && $("apiProvider").value) || "openai";
  const isOR = provider === "openrouter";
  const endpoint = isOR ? "https://openrouter.ai/api/v1/audio/transcriptions" : "https://api.openai.com/v1/audio/transcriptions";
  const model = isOR ? "openai/whisper-1" : "whisper-1";
  if (!key) { setStatus(`Paste your ${isOR ? "OpenRouter" : "OpenAI"} API key first — or use Auto-caption / script mode / the demo, no key needed.`, "error"); return; }
  if (!videoFile) { setStatus("Choose a video file first, then transcribe.", "error"); return; }
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
  } catch (err) {
    setStatus("Transcription failed: " + err.message + " Check your key, connection, and file size, then try again — or use script mode.", "error");
  }
});

/* ---------- Transcription + MP4 export: Caption AI backend (no key) ---------- */
function backendBase() {
  // Empty field = same origin (page served by the backend itself).
  return ($("backendUrl").value || "").trim().replace(/\/+$/, "");
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
$("autoCaptionBtn").addEventListener("click", async () => {
  if (!videoFile) { setStatus("Choose a video file first, then auto-caption it.", "error"); return; }
  if (videoFile.size > BACKEND_MAX_MB * 1024 * 1024) { setStatus(`⚠️ This video is ${(videoFile.size / 1048576).toFixed(0)} MB — over the backend's ${BACKEND_MAX_MB} MB limit. Please trim or compress it first (in VN Editor: export at 1080p instead of 4K).`, "error"); return; }
  const base = backendBase();
  const btn = $("autoCaptionBtn"); btn.disabled = true;
  setStatus(`Uploading ${videoFile.name} to the Caption AI backend for transcription… longer clips take a while, and the first run loads the Whisper model. Keep this tab open.`);
  try {
    const form = new FormData();
    form.append("file", videoFile, videoFile.name);
    const lang = $("languageSelect").value;
    if (lang) form.append("language", lang);
    const res = await fetch(base + "/api/transcribe", { method: "POST", body: form });
    if (!res.ok) throw new Error(await parseBackendError(res));
    const data = await res.json();
    if (!data.cues || !data.cues.length) throw new Error("The backend found no speech in this clip.");
    setCues(data.cues.map((c) => ({
      start: c.start, end: c.end, text: c.text,
      words: (c.words && c.words.length) ? c.words : (() => {
        const ws = c.text.trim().split(/\s+/).filter(Boolean); const per = ws.length ? (c.end - c.start) / ws.length : 0;
        return ws.map((w, j) => ({ word: w, start: c.start + j * per, end: c.start + (j + 1) * per }));
      })(),
    })), `Auto-caption done — the backend created ${data.cues.length} cues${data.language ? ` (detected language: ${data.language})` : ""}. Check the words, fix any mistakes, style them, then export.`);
  } catch (err) {
    setStatus("Auto-caption failed: " + (err && err.message ? err.message : err) + " — the backend may be unreachable. Check the Backend URL, or fall back to the Whisper key / script modes below; they still work.", "error");
  } finally { btn.disabled = false; }
});

$("exportMp4BackendBtn").addEventListener("click", async () => {
  if (!videoFile) { setStatus("Load a video first — backend MP4 export needs the original clip.", "error"); return; }
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
    setStatus("Backend MP4 export failed: " + (err && err.message ? err.message : err) + " — check the Backend URL / that the backend is running, or use the browser WebM export instead.", "error");
  } finally { btn.disabled = false; }
});

/* ---------- Transcription: script fallback + demo ---------- */
function captionsFromText(text, label) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) { setStatus("Paste some text first.", "error"); return; }
  const duration = (video.duration && isFinite(video.duration)) ? video.duration : Math.max(10, words.length / 2.5);
  setCues(splitIntoCues(words, duration), `${label}: created ${Math.ceil(words.length / 6)} cues timed across ${fmt(duration)}. ${video.duration ? "" : "Tip: load a video first for exact timing."}`);
}
$("scriptBtn").addEventListener("click", () => captionsFromText($("scriptInput").value, "Script mode"));
function loadDemo() {
  $("scriptInput").value = DEMO_TEXT;
  if (!video.duration || !isFinite(video.duration)) {
    // No video: build cues against demo duration so overlay/editor still work via playhead simulation is not needed;
    // cues use DEMO_DURATION and will sync once any video of similar length is loaded.
    setCues(splitIntoCues(DEMO_TEXT.split(/\s+/), DEMO_DURATION), "Demo loaded — Hinglish captions are ready in the editor. Drop any talking-head video to preview them on a real clip, edit the words, and try the styles.");
  } else {
    captionsFromText(DEMO_TEXT, "Demo loaded");
  }
  document.getElementById("editor").scrollIntoView({ behavior: "smooth" });
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
