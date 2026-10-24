"""
Caption AI backend — real server-side captioning, no API key needed.

Flow (the same thing hosted caption tools do on their servers):
  1. POST /api/transcribe  — upload a video, ffmpeg extracts its audio,
     faster-whisper transcribes it locally on the server, and the API
     returns timed caption cues (word-level) + an SRT string.
  2. POST /api/burn        — upload the video + an SRT, ffmpeg burns the
     captions into the picture (libass subtitles filter) and returns a
     real captioned MP4 file.

The static frontend (index.html / styles.css / app.js in the repo root)
is served at / by this same service, so one deployment = whole product.

Run locally:
    cd backend
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8000
    # open http://localhost:8000

Env vars:
    WHISPER_MODEL   faster-whisper model size (default "tiny"; try
                    "base" or "small" for better Hinglish accuracy)
    TRANSCRIBE_PROVIDER  "local" (default, faster-whisper on this server,
                    no key, no cost) or "openrouter" (send the audio to
                    OpenRouter's speech-to-text API instead)
    OPENROUTER_API_KEY   required when TRANSCRIBE_PROVIDER=openrouter
    GEMINI_API_KEY       required when TRANSCRIBE_PROVIDER=gemini (a free
                    key from Google AI Studio is fine). Gemini hears the
                    audio and writes timed segments; word timings inside
                    each segment are estimated evenly, not measured.
    GEMINI_MODEL         Gemini model slug (default "gemini-3.8-flash",
                    free-tier in AI Studio; the 2.5 family is closed
                    to new API users since late 2026)
    OPENROUTER_STT_MODEL OpenRouter STT model slug
                    (default "openai/whisper-1")
    MAX_UPLOAD_MB   upload size guard in MB (default 300 — VN Editor and
                    phone exports at 1080p are often a few hundred MB;
                    uploads are streamed to disk in 1 MB chunks, never
                    loaded into RAM, and only the extracted audio is used
                    for transcription, so large files stay cheap. In
                    openrouter mode the extracted MP3 is automatically
                    split into <24 MB chunks that are transcribed in
                    sequence with timestamps re-offset, because
                    OpenRouter's own upload cap is 25 MB)
    FRONTEND_DIR    where the static frontend lives (default: repo root,
                    i.e. the parent of this backend/ folder)

    Note on OpenRouter: its transcription endpoint is OpenAI-compatible,
    but it IGNORES the `prompt` field, so the Roman-script Hinglish
    biasing used locally does not apply there, and the audio upload is
    capped at 25 MB by OpenRouter. Local mode has neither limitation.

Privacy note: uploads are written to a temp folder, processed, and
deleted. Nothing is stored. This is a demo service — add auth, rate
limits and a job queue before exposing it to the public internet.
"""

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

MODEL_NAME = os.environ.get("WHISPER_MODEL", "tiny")
PROVIDER = os.environ.get("TRANSCRIBE_PROVIDER", "local").strip().lower()
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_STT_MODEL = os.environ.get("OPENROUTER_STT_MODEL", "openai/whisper-1")
OPENROUTER_URL = "https://openrouter.ai/api/v1/audio/transcriptions"
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "300")) * 1024 * 1024
BACKEND_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = Path(os.environ.get("FRONTEND_DIR", BACKEND_DIR.parent))

HINGLISH_PROMPT = (
    "Yaar suno, aaj main aapko ek simple trick batane wala hoon. This is "
    "Hinglish content, a mix of Hindi and English, transcribed in Roman "
    "script, for example: bahut accha, matlab, aaj kal, bilkul sahi hai, "
    "game changer hai."
)

app = FastAPI(title="Caption AI backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache_frontend(request, call_next):
    """The frontend must never be served stale from a browser cache: a cached
    app.js once kept an old download flow alive after the fix deployed."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

# ---------------------------------------------------------------- model ----
_model = None
_model_lock = threading.Lock()


def get_model():
    """Load faster-whisper lazily, once (first load downloads the model)."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from faster_whisper import WhisperModel

                _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    return _model


# ------------------------------------------------------------- helpers -----
def json_error(message, status=400):
    return JSONResponse({"ok": False, "error": message}, status_code=status)


def run(cmd, timeout=None):
    """Run a command, return (ok, stderr_tail). Logs start/finish so slow
    steps (ffmpeg encodes on small instances) are visible in server logs."""
    import time
    label = cmd[0] if cmd else "cmd"
    print(f"[run] start: {' '.join(map(str, cmd))[:200]}", flush=True)
    started = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f"[run] TIMEOUT after {timeout}s: {label}", flush=True)
        return False, f"{label} timed out after {timeout}s on the server."
    elapsed = time.time() - started
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-800:]
        print(f"[run] FAILED in {elapsed:.1f}s rc={proc.returncode}: {tail[-300:]}", flush=True)
        return False, tail
    print(f"[run] ok in {elapsed:.1f}s: {label}", flush=True)
    return True, ""


def fmt_srt_time(t):
    total_ms = int(round(max(0.0, float(t)) * 1000))
    h, rem = divmod(total_ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def cues_to_srt(cues):
    return "".join(
        f"{i}\n{fmt_srt_time(c['start'])} --> {fmt_srt_time(c['end'])}\n{c['text'].strip()}\n\n"
        for i, c in enumerate(cues, 1)
    )


def save_upload(file, dest):
    """Stream an UploadFile to disk enforcing the size guard."""
    size = 0
    with open(dest, "wb") as out:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise ValueError(f"File is over the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit.")
            out.write(chunk)
    return size


def extract_audio(video_path, wav_path):
    return run([
        "ffmpeg", "-y", "-v", "error", "-i", str(video_path),
        "-vn", "-ac", "1", "-ar", "16000", str(wav_path),
    ])


def words_to_cues(words):
    """Group timed words into ~6-word cues, breaking on a >1s pause."""
    chunks, chunk = [], []
    for w in words:
        if chunk and (len(chunk) >= 6 or w["start"] - chunk[-1]["end"] > 1.0):
            chunks.append(chunk)
            chunk = []
        chunk.append(w)
    if chunk:
        chunks.append(chunk)
    return [{
        "start": c[0]["start"], "end": c[-1]["end"],
        "text": " ".join(w["word"] for w in c).strip(),
        "words": c,
    } for c in chunks]


def probe_duration(path):
    """Duration in seconds via ffprobe, 0 if unreadable."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=60)
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def _extract_words(data):
    """Pull a flat timed-word list out of an OpenAI-compatible
    verbose_json response (words, else segments, else plain text)."""
    words = []
    if isinstance(data.get("words"), list) and data["words"]:
        words = [{"word": str(w.get("word", "")).strip(),
                  "start": round(float(w.get("start", 0)), 3),
                  "end": round(float(w.get("end", 0)), 3)}
                 for w in data["words"] if str(w.get("word", "")).strip()]
    elif isinstance(data.get("segments"), list) and data["segments"]:
        for seg in data["segments"]:
            text = str(seg.get("text", "")).strip()
            if not text:
                continue
            ws = text.split()
            start, end = float(seg.get("start", 0)), float(seg.get("end", 0))
            per = (end - start) / max(1, len(ws))
            words.extend({"word": t, "start": round(start + i * per, 3),
                          "end": round(start + (i + 1) * per, 3)} for i, t in enumerate(ws))
    elif data.get("text"):
        ws = str(data["text"]).strip().split()
        per = 0.4  # no timing info at all: ~2.5 words/sec estimate
        words = [{"word": t, "start": round(i * per, 3), "end": round((i + 1) * per, 3)}
                 for i, t in enumerate(ws)]
    return words


def api_json_to_result(data):
    """Normalize an OpenAI-compatible verbose_json response into
    (cues, duration, language)."""
    cues = words_to_cues(_extract_words(data))
    duration = data.get("duration")
    if not duration:
        duration = cues[-1]["end"] if cues else 0
    return cues, round(float(duration), 3), data.get("language")


# ------------------------------------------------------- OpenRouter --------
def _post_multipart(url, fields, file_field, filename, file_bytes, headers):
    """Minimal multipart/form-data POST (stdlib only). Returns parsed JSON.
    Kept as a small separate function so tests can monkeypatch it."""
    boundary = "----captionai" + uuid.uuid4().hex
    body = bytearray()
    for name, value in fields:
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        body += f"{value}\r\n".encode()
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode()
    body += b"Content-Type: audio/mpeg\r\n\r\n"
    body += file_bytes
    body += f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(url, data=bytes(body), method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"OpenRouter returned {exc.code}: {detail}") from exc


OPENROUTER_MAX_BYTES = 24 * 1024 * 1024  # stay safely under its 25 MB cap


def _openrouter_fields(language):
    fields = [
        ("model", OPENROUTER_STT_MODEL),
        ("response_format", "verbose_json"),
        ("temperature", "0"),
        ("timestamp_granularities[]", "word"),
        ("timestamp_granularities[]", "segment"),
        # `prompt` is accepted by OpenRouter but IGNORED, so it is not sent:
        # Roman-Hinglish biasing only works with the local provider.
    ]
    if language:
        fields.append(("language", language))
    return fields


def _openrouter_transcribe_file(mp3_path, language, key):
    """One OpenRouter call for one MP3 file. Returns the parsed JSON."""
    return _post_multipart(OPENROUTER_URL, _openrouter_fields(language), "file",
                           Path(mp3_path).name, Path(mp3_path).read_bytes(),
                           {"Authorization": "Bearer " + key})


def transcribe_with_openrouter(audio_mp3_path, language, work_dir=None, api_key=None):
    """Transcribe an extracted MP3 via OpenRouter, chunking if needed.

    The *video* can be up to the 300 MB backend limit — that doesn't matter
    to OpenRouter, because only the extracted mono MP3 is sent. If even the
    MP3 is over the provider's 25 MB cap (roughly >50 min of speech), it is
    split with ffmpeg's segment muxer into <24 MB chunks, each chunk is
    transcribed in order, and the word timestamps are shifted by the
    cumulative chunk offsets before the cues are rebuilt.
    Returns (cues, duration, language)."""
    key = (api_key or OPENROUTER_API_KEY or "").strip()
    if not key:
        raise RuntimeError("No OpenRouter API key is set. Add one in Advanced options, or set OPENROUTER_API_KEY on the server.")
    audio_mp3_path = Path(audio_mp3_path)
    if audio_mp3_path.stat().st_size <= OPENROUTER_MAX_BYTES:
        return api_json_to_result(_openrouter_transcribe_file(audio_mp3_path, language, key))

    total_duration = probe_duration(audio_mp3_path)
    if not total_duration:
        raise RuntimeError("Could not measure the extracted audio, so it cannot be chunked for OpenRouter.")
    size = audio_mp3_path.stat().st_size
    chunk_seconds = int(max(60, min(1200, total_duration * (OPENROUTER_MAX_BYTES / size) * 0.92)))
    work_dir = Path(work_dir or audio_mp3_path.parent)
    ok, err = run([
        "ffmpeg", "-y", "-v", "error", "-i", str(audio_mp3_path),
        "-f", "segment", "-segment_time", str(chunk_seconds), "-c", "copy",
        str(work_dir / "chunk%03d.mp3"),
    ])
    chunk_files = sorted(work_dir.glob("chunk*.mp3"))
    if not ok or not chunk_files:
        raise RuntimeError("ffmpeg could not split the long audio into chunks for OpenRouter. " + err)

    all_words, offset, detected = [], 0.0, None
    for chunk_file in chunk_files:
        data = _openrouter_transcribe_file(chunk_file, language, key)
        for w in _extract_words(data):
            all_words.append({"word": w["word"],
                              "start": round(w["start"] + offset, 3),
                              "end": round(w["end"] + offset, 3)})
        detected = detected or data.get("language")
        offset += probe_duration(chunk_file) or float(data.get("duration") or chunk_seconds)
    return words_to_cues(all_words), round(offset, 3), detected


# ---------------------------------------------------------------- Gemini ---
# Google Gemini via its generateContent REST API: the extracted audio is
# sent inline (base64) and the model replies with JSON segments carrying
# start/end seconds. A free AI Studio key works on the free tier. Gemini
# does not measure word timings, so words inside a segment are spread
# evenly — caption timing is approximate, unlike local Whisper.
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_INLINE_MAX_BYTES = 18 * 1024 * 1024  # inline requests cap ~20 MB total

GEMINI_PROMPT = (
    "Transcribe the speech in this audio exactly as spoken, word for word. "
    "The speech is Hinglish \u2014 a mix of Hindi and English. Write ALL of it "
    "in Roman (Latin) script only, exactly as it sounds: Hindi words in Roman "
    "letters (for example: yaar, bahut accha, matlab, aaj main aapko batane "
    "wala hoon), never in Devanagari script. Skip music and silence. Break "
    "the transcript into SHORT segments of roughly 1 to 3 seconds at natural "
    "pauses \u2014 end each segment at a pause, and never stretch one segment "
    "across a silence or music. Each segment needs its start and end time "
    "in seconds. Reply with JSON "
    "only, in this shape: "
    "{\"segments\": [{\"start\": 0.0, \"end\": 2.5, \"text\": \"...\"}]}"
)

GEMINI_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "segments": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "start": {"type": "NUMBER"},
                    "end": {"type": "NUMBER"},
                    "text": {"type": "STRING"},
                },
                "required": ["start", "end", "text"],
            },
        }
    },
    "required": ["segments"],
}


def _gemini_error_message(code, detail):
    low = (detail or "").lower()
    if code == 503 or "unavailable" in low or "high demand" in low:
        return ("Gemini is busy right now \u2014 high demand on the free tier. "
                "This is temporary: wait a minute and try again.")
    if code == 429 or "quota" in low or "rate" in low:
        return ("Gemini's free limit was hit (too many requests, or the daily "
                "free quota is used up). Wait a minute and try again \u2014 if it "
                "keeps failing, the free quota resets tomorrow.")
    if code == 404 or "no longer available" in low or "not found" in low:
        return ("That Gemini model is not available for your API key. Set "
                "GEMINI_MODEL to a current model (for example gemini-3.8-flash) and try again.")
    if "api_key_invalid" in low or "api key not valid" in low or (code in (400, 401, 403) and "key" in low):
        return ("That Gemini API key was rejected by Google. Check the key "
                "and try again \u2014 a free key comes from Google AI Studio.")
    return f"Gemini returned {code}: {detail[:300]}"


class GeminiError(RuntimeError):
    """A Gemini API failure, carrying the HTTP status for retry logic."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def _post_json(url, payload, headers):
    """Minimal JSON POST (stdlib only). Returns parsed JSON.
    Kept as a small separate function so tests can monkeypatch it."""
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:600]
        raise GeminiError(_gemini_error_message(exc.code, detail), code=exc.code) from exc


def _gemini_parse_segments(data):
    """Pull [{start, end, text}] out of a generateContent response."""
    try:
        parts = data["candidates"][0]["content"]["parts"]
        text = "".join(str(p.get("text", "")) for p in parts)
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("Gemini replied in an unexpected shape \u2014 no transcript was returned.") from exc
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise RuntimeError("Gemini's reply could not be read as a transcript. Please try again.") from exc
    raw = parsed.get("segments") if isinstance(parsed, dict) else parsed
    segments = []
    for seg in raw or []:
        try:
            start, end = float(seg["start"]), float(seg["end"])
        except (KeyError, TypeError, ValueError):
            continue
        txt = str(seg.get("text", "")).strip()
        if not txt:
            continue
        if end <= start:
            end = start + 0.5
        segments.append({"start": round(start, 3), "end": round(end, 3), "text": txt})
    segments.sort(key=lambda sgm: sgm["start"])
    # Gemini's timestamps can overlap slightly between neighbouring
    # segments; clamp each start to the previous end so captions never
    # fight each other on screen.
    prev_end = 0.0
    for sgm in segments:
        if sgm["start"] < prev_end:
            sgm["start"] = prev_end
        if sgm["end"] <= sgm["start"]:
            sgm["end"] = round(sgm["start"] + 0.4, 3)
        prev_end = sgm["end"]
    return segments


def _gemini_transcribe_mp3(mp3_path, key):
    """One Gemini call for one MP3 file. Returns raw segment dicts."""
    audio_b64 = base64.b64encode(Path(mp3_path).read_bytes()).decode("ascii")
    payload = {
        "contents": [{"parts": [
            {"text": GEMINI_PROMPT},
            {"inline_data": {"mime_type": "audio/mpeg", "data": audio_b64}},
        ]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_RESPONSE_SCHEMA,
        },
    }
    url = f"{GEMINI_API_BASE}/{GEMINI_MODEL}:generateContent"
    # The free tier regularly answers 503 "high demand" in bursts; those
    # clear within seconds, so retry twice before troubling the user.
    for attempt in range(3):
        try:
            return _gemini_parse_segments(_post_json(url, payload, {"x-goog-api-key": key}))
        except GeminiError as exc:
            if exc.code == 503 and attempt < 2:
                time.sleep(5 if attempt == 0 else 20)
                continue
            raise


def _segments_to_cues(segments):
    """Segments -> cues, spreading each segment's words evenly across it."""
    words = []
    for seg in segments:
        ws = seg["text"].split()
        if not ws:
            continue
        per = (seg["end"] - seg["start"]) / len(ws)
        words.extend({"word": t, "start": round(seg["start"] + i * per, 3),
                      "end": round(seg["start"] + (i + 1) * per, 3)} for i, t in enumerate(ws))
    return words_to_cues(words)


def transcribe_with_gemini(audio_path, language, api_key=None, work_dir=None):
    """Transcribe extracted audio via Google Gemini (free-tier friendly).

    Returns (cues, duration, language). The audio is sent as a compact
    mono MP3 inline; if it is too large for one inline request it is
    split into ~8-minute chunks whose segment times are re-offset."""
    key = (api_key or GEMINI_API_KEY or "").strip()
    if not key:
        raise RuntimeError("No Gemini API key is set. Add one in Advanced options, or set GEMINI_API_KEY on the server.")
    audio_path = Path(audio_path)
    work_dir = Path(work_dir or audio_path.parent)
    mp3_path = audio_path
    if audio_path.suffix.lower() != ".mp3":
        mp3_path = work_dir / "gemini-audio.mp3"
        ok, err = run([
            "ffmpeg", "-y", "-v", "error", "-i", str(audio_path),
            "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "48k",
            str(mp3_path),
        ])
        if not ok:
            raise RuntimeError("ffmpeg could not prepare the audio for Gemini. " + err)
    if mp3_path.stat().st_size <= GEMINI_INLINE_MAX_BYTES:
        segments = _gemini_transcribe_mp3(mp3_path, key)
        cues = _segments_to_cues(segments)
        duration = segments[-1]["end"] if segments else 0
        return cues, round(float(duration), 3), None

    total = probe_duration(mp3_path)
    if not total:
        raise RuntimeError("Could not measure the extracted audio, so it cannot be chunked for Gemini.")
    size = mp3_path.stat().st_size
    chunk_seconds = int(max(60, min(480, total * (GEMINI_INLINE_MAX_BYTES / size) * 0.92)))
    ok, err = run([
        "ffmpeg", "-y", "-v", "error", "-i", str(mp3_path),
        "-f", "segment", "-segment_time", str(chunk_seconds), "-c", "copy",
        str(work_dir / "gchunk%03d.mp3"),
    ])
    chunk_files = sorted(work_dir.glob("gchunk*.mp3"))
    if not ok or not chunk_files:
        raise RuntimeError("ffmpeg could not split the long audio into chunks for Gemini. " + err)
    all_segments, offset = [], 0.0
    for chunk_file in chunk_files:
        for seg in _gemini_transcribe_mp3(chunk_file, key):
            all_segments.append({"start": round(seg["start"] + offset, 3),
                                 "end": round(seg["end"] + offset, 3),
                                 "text": seg["text"]})
        offset += probe_duration(chunk_file) or chunk_seconds
    return _segments_to_cues(all_segments), round(float(offset), 3), None


# ---------------------------------------------------------------- API ------
@app.get("/health")
def health():
    return {
        "ok": True,
        "provider": PROVIDER,
        "model": {"openrouter": OPENROUTER_STT_MODEL, "gemini": GEMINI_MODEL}.get(PROVIDER, MODEL_NAME),
        "model_loaded": _model is not None,
    }


@app.post("/api/transcribe")
def transcribe(file: UploadFile = File(...), language: str = Form(""),
               provider: str = Form(""), api_key: str = Form("")):
    tmp = Path(tempfile.mkdtemp(prefix="captionai-"))
    try:
        suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
        video_path = tmp / f"input{suffix}"
        try:
            size = save_upload(file, video_path)
        except ValueError as exc:
            return json_error(str(exc), status=413)
        if size == 0:
            return json_error("The uploaded file was empty.")

        lang = language.strip() or None
        eff_provider = (provider or PROVIDER).strip().lower()
        if eff_provider not in ("local", "openrouter", "gemini"):
            eff_provider = PROVIDER
        req_key = api_key.strip() or None

        if eff_provider == "gemini":
            mp3_path = tmp / "audio.mp3"
            ok, err = run([
                "ffmpeg", "-y", "-v", "error", "-i", str(video_path),
                "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-q:a", "4",
                str(mp3_path),
            ])
            if not ok:
                return json_error("ffmpeg could not extract audio from that file. Is it a valid video? " + err, status=422)
            try:
                cue_list, duration, detected = transcribe_with_gemini(mp3_path, lang, api_key=req_key, work_dir=tmp)
            except RuntimeError as exc:
                return json_error(str(exc), status=502)
            return {
                "ok": True,
                "provider": "gemini",
                "duration": duration,
                "language": detected,
                "cues": cue_list,
                "srt": cues_to_srt(cue_list),
            }

        if eff_provider == "openrouter":
            mp3_path = tmp / "audio.mp3"
            ok, err = run([
                "ffmpeg", "-y", "-v", "error", "-i", str(video_path),
                "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-q:a", "4",
                str(mp3_path),
            ])
            if not ok:
                return json_error("ffmpeg could not extract audio from that file. Is it a valid video? " + err, status=422)
            try:
                cue_list, duration, detected = transcribe_with_openrouter(mp3_path, lang, work_dir=tmp, api_key=req_key)
            except RuntimeError as exc:
                return json_error(str(exc), status=502)
            return {
                "ok": True,
                "provider": "openrouter",
                "duration": duration,
                "language": detected,
                "cues": cue_list,
                "srt": cues_to_srt(cue_list),
            }

        wav_path = tmp / "audio.wav"
        ok, err = extract_audio(video_path, wav_path)
        if not ok:
            return json_error("ffmpeg could not extract audio from that file. Is it a valid video? " + err, status=422)

        model = get_model()
        segments, info = model.transcribe(
            str(wav_path),
            language=lang,
            word_timestamps=True,
            initial_prompt=HINGLISH_PROMPT,
            vad_filter=False,
        )

        words = []
        for seg in segments:
            for w in (seg.words or []):
                words.append({"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
            if not seg.words and seg.text.strip():
                ws = seg.text.strip().split()
                per = (seg.end - seg.start) / max(1, len(ws))
                words.extend({"word": t, "start": round(seg.start + i * per, 3),
                              "end": round(seg.start + (i + 1) * per, 3)} for i, t in enumerate(ws))

        cue_list = words_to_cues(words)
        duration = round(float(getattr(info, "duration", 0) or (cue_list[-1]["end"] if cue_list else 0)), 3)
        return {
            "ok": True,
            "duration": duration,
            "language": getattr(info, "language", None),
            "provider": "local",
            "cues": cue_list,
            "srt": cues_to_srt(cue_list),
        }
    except Exception as exc:  # surface a clear JSON error, never an HTML 500
        return json_error(f"Transcription failed: {exc}", status=500)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- jobs -----
# Job-based transcription with REAL progress. POST /api/jobs stores the
# upload, returns a job_id immediately, and a background thread runs the
# same pipeline as /api/transcribe — except the faster-whisper segment
# generator is consumed step by step, so progress is MEASURED from the
# audio itself (last segment end / total duration), never from a timer.
# Stage bands: preparing 2-10%, transcribing 10-80% (segment-measured),
# generating_captions 80-92%, preparing_editor 92-99%, completed = 100
# only when the result payload is ready. For the OpenRouter provider
# there is no segment stream, so transcribing progress is null
# (indeterminate) rather than invented.
JOB_TTL_SECONDS = 30 * 60
_jobs = {}
_jobs_lock = threading.Lock()
_transcribe_lock = threading.Lock()

JOB_STAGES = ["uploaded", "preparing", "transcribing",
              "generating_captions", "preparing_editor", "completed"]


def _job_view(job):
    now = time.time()
    end = job["finished_at"] or now
    return {
        "ok": True,
        "job_id": job["id"],
        "status": job["status"],
        "stage": job["stage"],
        "progress_percentage": job["progress"],
        "elapsed_seconds": round(end - job["created_at"], 1),
        "estimated_remaining_seconds": job["eta"] if job["status"] == "processing" else None,
        "message": job["message"],
        "error": job["error"],
        "result": job["result"] if job["status"] == "completed" else None,
    }


def _get_job(job_id):
    """Fetch a job, lazily expiring finished jobs after the TTL."""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        if job["finished_at"] and time.time() - job["finished_at"] > JOB_TTL_SECONDS:
            del _jobs[job_id]
            return None
        return job


def _set(job, **kw):
    with _jobs_lock:
        job.update(kw)


def _finish(job, status, stage, message, error=None):
    _set(job, status=status, stage=stage, message=message, error=error,
         eta=None, finished_at=time.time())


def _run_job(job, video_path, language, tmp):
    """Worker thread: preparing -> transcribing -> generating_captions
    -> preparing_editor -> completed (or failed / cancelled)."""
    cancel = job["cancel"]
    job_provider = (job.get("provider") or PROVIDER).strip().lower()
    job_key = job.get("api_key") or None

    def was_cancelled():
        if cancel.is_set():
            _finish(job, "cancelled", job["stage"], "Captioning cancelled.")
            return True
        return False

    try:
        _set(job, status="processing", stage="preparing", progress=2,
             message="Preparing your video…")
        if was_cancelled():
            return

        # --- preparing: validate + extract the audio track ---------------
        if job_provider in ("openrouter", "gemini"):
            audio_path = tmp / "audio.mp3"
            ok, err = run([
                "ffmpeg", "-y", "-v", "error", "-i", str(video_path),
                "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-q:a", "4",
                str(audio_path),
            ])
        else:
            audio_path = tmp / "audio.wav"
            ok, err = extract_audio(video_path, audio_path)
        if not ok:
            _finish(job, "failed", "preparing",
                    "Captioning failed while preparing your video.",
                    error={"stage": "preparing",
                           "message": "ffmpeg could not extract audio from that file. Is it a valid video? " + err})
            return
        _set(job, progress=10)
        if was_cancelled():
            return

        # --- transcribing --------------------------------------------------
        _set(job, stage="transcribing", message="Listening to your audio…")
        words, cues, duration, detected = [], None, 0.0, None
        if job_provider == "gemini":
            _set(job, progress=None)  # single API call: indeterminate
            if was_cancelled():
                return
            try:
                cues, duration, detected = transcribe_with_gemini(audio_path, language, api_key=job_key, work_dir=tmp)
            except RuntimeError as exc:
                _finish(job, "failed", "transcribing",
                        "Captioning failed while transcribing your audio.",
                        error={"stage": "transcribing", "message": str(exc)})
                return
            words = [w for c in cues for w in (c.get("words") or [])]
            if was_cancelled():
                return
        elif job_provider == "openrouter":
            _set(job, progress=None)  # no segment stream: indeterminate
            if was_cancelled():
                return
            try:
                cues, duration, detected = transcribe_with_openrouter(audio_path, language, work_dir=tmp, api_key=job_key)
            except RuntimeError as exc:
                _finish(job, "failed", "transcribing",
                        "Captioning failed while transcribing your audio.",
                        error={"stage": "transcribing", "message": str(exc)})
                return
            words = [w for c in cues for w in (c.get("words") or [])]
            if was_cancelled():
                return
        else:
            # The model lock keeps two jobs (or a job + nothing else) from
            # fighting over the CPU-bound model; HTTP stays responsive
            # because this runs on the worker thread, not a request thread.
            with _transcribe_lock:
                model = get_model()
                segments, info = model.transcribe(
                    str(audio_path),
                    language=language,
                    word_timestamps=True,
                    initial_prompt=HINGLISH_PROMPT,
                    vad_filter=False,
                )
                duration = float(getattr(info, "duration", 0) or 0) or probe_duration(audio_path)
                detected = getattr(info, "language", None)
                t0 = time.time()
                rate = None  # smoothed audio-seconds per real second
                for seg in segments:
                    if cancel.is_set():
                        _finish(job, "cancelled", "transcribing", "Captioning cancelled.")
                        return
                    for w in (seg.words or []):
                        words.append({"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
                    if not seg.words and seg.text.strip():
                        ws = seg.text.strip().split()
                        per = (seg.end - seg.start) / max(1, len(ws))
                        words.extend({"word": t, "start": round(seg.start + i * per, 3),
                                      "end": round(seg.start + (i + 1) * per, 3)} for i, t in enumerate(ws))
                    # REAL progress: how much audio has actually been
                    # transcribed, measured from the segment timestamps.
                    if duration > 0:
                        frac = min(1.0, seg.end / duration)
                        elapsed_real = time.time() - t0
                        eta = None
                        if seg.end > 2 and elapsed_real > 1:
                            inst = seg.end / elapsed_real
                            rate = inst if rate is None else 0.7 * rate + 0.3 * inst
                            if rate > 0:
                                eta = round((duration - seg.end) / rate, 1)
                        _set(job, progress=round(10 + 70 * frac, 1), eta=eta,
                             message=f"Listening to your audio… ({int(frac * 100)}% of the audio done)")

        # --- generating_captions ------------------------------------------
        _set(job, stage="generating_captions", progress=80, eta=None,
             message="Writing your Hinglish captions…")
        if cues is None:
            cues = words_to_cues(words)
        if not cues:
            _finish(job, "failed", "generating_captions",
                    "Captioning failed while writing captions.",
                    error={"stage": "generating_captions",
                           "message": "No speech was found in this clip, so there is nothing to caption. Check that the video has audible speech and try again."})
            return
        srt = cues_to_srt(cues)
        if was_cancelled():
            return

        # --- preparing_editor ----------------------------------------------
        _set(job, stage="preparing_editor", progress=92,
             message="Getting your captions ready to edit…")
        result = {
            "cues": cues,
            "words": words,
            "srt": srt,
            "language": detected,
            "duration": round(float(duration), 3),
            "provider": job_provider,
        }
        _set(job, progress=99, result=result)
        _finish(job, "completed", "completed", "Your captions are ready!")
        _set(job, progress=100)
    except Exception as exc:  # never leave a job hanging in "processing"
        _finish(job, "failed", job["stage"], "Captioning failed.",
                error={"stage": job["stage"], "message": f"Captioning failed: {exc}"})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/jobs")
def create_job(file: UploadFile = File(...), language: str = Form(""),
               provider: str = Form(""), api_key: str = Form("")):
    tmp = Path(tempfile.mkdtemp(prefix="captionai-job-"))
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    video_path = tmp / f"input{suffix}"
    try:
        size = save_upload(file, video_path)
    except ValueError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        return json_error(str(exc), status=413)
    if size == 0:
        shutil.rmtree(tmp, ignore_errors=True)
        return json_error("The uploaded file was empty.")
    eff_provider = (provider or PROVIDER).strip().lower()
    if eff_provider not in ("local", "openrouter", "gemini"):
        eff_provider = PROVIDER
    job_id = uuid.uuid4().hex
    job = {
        "provider": eff_provider, "api_key": api_key.strip() or None,
        "id": job_id, "status": "queued", "stage": "uploaded", "progress": 0,
        "eta": None, "message": "Video received — captioning will start in a moment.",
        "error": None, "result": None,
        "created_at": time.time(), "finished_at": None,
        "cancel": threading.Event(),
    }
    with _jobs_lock:
        # Lazy housekeeping: drop expired finished jobs on new submissions.
        expired = [jid for jid, j in _jobs.items()
                   if j["finished_at"] and time.time() - j["finished_at"] > JOB_TTL_SECONDS]
        for jid in expired:
            del _jobs[jid]
        _jobs[job_id] = job
    threading.Thread(target=_run_job, args=(job, video_path, language.strip() or None, tmp),
                     daemon=True).start()
    return {"ok": True, "job_id": job_id, "status": "queued"}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = _get_job(job_id)
    if job is None:
        return json_error("Job not found — it may have expired (finished jobs are kept for about 30 minutes).", status=404)
    return _job_view(job)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = _get_job(job_id)
    if job is None:
        return json_error("Job not found — it may have expired (finished jobs are kept for about 30 minutes).", status=404)
    if job["status"] in ("queued", "processing"):
        job["cancel"].set()
    return _job_view(job)


def _burn_vf(srt_path, fontsize, color, position):
    """The ffmpeg subtitles-filter argument shared by /api/burn and the
    burn jobs, so both render identically styled captions."""
    def hex_to_ass(value):
        m = re.fullmatch(r"#?([0-9a-fA-F]{6})", (value or "").strip())
        if not m:
            return "&HFFFFFF"
        r, g, b = (m.group(1)[i:i + 2] for i in (0, 2, 4))
        return f"&H{b}{g}{r}".upper()

    alignment = {"bottom": 2, "middle": 5, "top": 8}.get((position or "bottom").lower(), 2)
    margin_v = 36 if alignment != 5 else 0
    force_style = (
        f"FontName=DejaVu Sans,FontSize={max(10, min(60, int(fontsize)))},"
        f"PrimaryColour={hex_to_ass(color)},OutlineColour=&H99000000,"
        f"BorderStyle=1,Outline=2,Shadow=0,Bold=1,"
        f"Alignment={alignment},MarginV={margin_v}"
    )
    return f"subtitles={srt_path}:force_style='{force_style}'"


def probe_dimensions(path):
    """(width, height) of the first video stream, (0, 0) if unreadable.

    Defensive cascade: a real VN export produced ffprobe output the original
    one-line csv split could not parse, which silently returned (0, 0) and
    disabled the styled burn (job 3dbf49c5 logged dims=0x0 with cues present).
    1) ffprobe JSON — first video stream with integer dims (rotation-aware:
       ASS PlayRes lives in display space, so 90/270 swaps the pair).
    2) ffprobe csv — first line that is exactly WxH.
    3) ffmpeg -i banner — the Video stream line.
    Every failure is logged; silence here once hid the whole bug.
    """
    def _maybe_swap(w, h, rotation):
        try:
            r = abs(int(rotation)) % 180
        except (TypeError, ValueError):
            r = 0
        return (h, w) if r == 90 else (w, h)

    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=codec_type,width,height:stream_tags=rotate",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=60)
        data = json.loads(out.stdout or "{}")
        for st in data.get("streams", []):
            if st.get("codec_type") != "video":
                continue
            w, h = int(st.get("width") or 0), int(st.get("height") or 0)
            if w > 0 and h > 0:
                rot = (st.get("tags") or {}).get("rotate")
                for sd in st.get("side_data_list", []) or []:
                    if sd.get("rotation") is not None:
                        rot = sd.get("rotation")
                return _maybe_swap(w, h, rot)
        print(f"[burn] probe json: no video dims in {(out.stdout or '')[:160]!r}", flush=True)
    except Exception as exc:
        print(f"[burn] probe json failed: {exc!r}", flush=True)
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height",
             "-of", "csv=p=0:s=x", str(path)],
            capture_output=True, text=True, timeout=60)
        for line in (out.stdout or "").splitlines():
            m = re.fullmatch(r"\s*(\d+)x(\d+)\s*", line)
            if m:
                return int(m.group(1)), int(m.group(2))
        print(f"[burn] probe csv unparsable: {(out.stdout or '')[:160]!r}", flush=True)
    except Exception as exc:
        print(f"[burn] probe csv failed: {exc!r}", flush=True)
    try:
        out = subprocess.run(["ffmpeg", "-i", str(path)],
                             capture_output=True, text=True, timeout=60)
        m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", out.stderr or "")
        if m:
            return int(m.group(1)), int(m.group(2))
        print("[burn] probe ffmpeg-i: no Video dims found", flush=True)
    except Exception as exc:
        print(f"[burn] probe ffmpeg-i failed: {exc!r}", flush=True)
    return 0, 0


def _ass_color(hex_value, alpha="00"):
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", (hex_value or "").strip())
    if not m:
        return f"&H{alpha}FFFFFF"
    r, g, b = (m.group(1)[i:i + 2] for i in (0, 2, 4))
    return f"&H{alpha}{b}{g}{r}".upper()


def _ass_time(sec):
    sec = max(0.0, float(sec))
    h = int(sec // 3600); m = int((sec % 3600) // 60)
    s_int = int(sec % 60); cs = int(round((sec - int(sec)) * 100))
    if cs == 100:
        s_int += 1; cs = 0
    return f"{h}:{m:02d}:{s_int:02d}.{cs:02d}"


def _ass_escape(text):
    return (str(text).replace("\\", " ").replace("{", "").replace("}", "")
            .replace("\n", " ").replace("\r", " ").strip())


def build_ass(cues, width, height, font_px, base_color, highlight_color,
              karaoke, bg, position):
    """Build an ASS subtitle file that matches the editor preview: the
    PlayRes IS the real video resolution and the font size is in real
    pixels, so burned captions come out the same size as the preview —
    and with karaoke word timings, libass sweeps each word from the base
    colour to the highlight colour as it is spoken (\\kf tags)."""
    alignment = {"bottom": 2, "middle": 5, "top": 8}.get((position or "bottom").lower(), 2)
    margin_v = {"bottom": round(height * 0.10), "top": round(height * 0.08)}.get(
        (position or "bottom").lower(), 0)
    # In ASS karaoke, unspoken text uses SecondaryColour and the sweep
    # fills it with PrimaryColour — the preview does exactly the same
    # (base colour first, highlight once a word is spoken).
    primary = _ass_color(highlight_color if karaoke else base_color)
    secondary = _ass_color(base_color)
    border_style = 3 if bg else 1
    outline = max(1, round(font_px * (0.18 if bg else 0.07)))
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,{font_px},{primary},{secondary},&H99000000,&H47000000,-1,0,0,0,100,100,0,0,{border_style},{outline},0,{alignment},{round(width * 0.08)},{round(width * 0.08)},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for cue in cues:
        start, end = float(cue.get("start", 0)), float(cue.get("end", 0))
        if end <= start:
            continue
        words = cue.get("words") or []
        if karaoke and words:
            parts = []
            first_start = float(words[0].get("start", start))
            gap_cs = int(round((first_start - start) * 100))
            if gap_cs > 3:
                parts.append(f"{{\\kf{gap_cs}}}")
            for w in words:
                dur_cs = max(1, int(round((float(w.get("end", start)) - float(w.get("start", start))) * 100)))
                parts.append(f"{{\\kf{dur_cs}}}" + _ass_escape(w.get("word", "")) + " ")
            text = "".join(parts).strip()
        else:
            text = _ass_escape(cue.get("text", ""))
        if not text:
            continue
        lines.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{text}")
    return "\n".join(lines) + "\n"


def _choose_subs(tmp, video_path, srt_text, fontsize, color, position,
                 cues_json="", highlight="", karaoke="", bg="", font_px=0):
    """Pick the subtitle source for a burn: a styled ASS built from the
    editor's cues (exact size + karaoke) when cue JSON was sent, else the
    legacy SRT + force_style path. Returns (subs_path, vf_filter)."""
    cues = None
    if cues_json:
        try:
            parsed = json.loads(cues_json)
            if isinstance(parsed, list) and parsed:
                cues = parsed
        except ValueError:
            cues = None
    if cues:
        width, height = probe_dimensions(video_path)
        print(f"[burn] subs choice: cues={len(cues)} dims={width}x{height} font_px={font_px}", flush=True)
        if width > 0 and height > 0:
            eff_px = font_px if 8 <= font_px <= 600 else max(14, round(fontsize * height / 288))
            ass_path = tmp / "subs.ass"
            ass_path.write_text(build_ass(
                cues, width, height, eff_px, color, highlight or color,
                karaoke.strip().lower() in ("1", "true", "yes"),
                bg.strip().lower() in ("1", "true", "yes"),
                position), encoding="utf-8")
            return ass_path, f"subtitles={ass_path}"
    print(f"[burn] subs choice: LEGACY SRT path (cues_json={'yes' if cues_json else 'no'})", flush=True)
    srt_path = tmp / "subs.srt"
    srt_path.write_text(srt_text, encoding="utf-8")
    return srt_path, _burn_vf(srt_path, fontsize, color, position)


# ------------------------------------------------------------- burn jobs ---
# Rendering a captioned MP4 on a CPU-capped free server takes minutes, so
# a single blocking request feels broken (and can die at a proxy). Burn
# jobs render in a background thread while ffmpeg's own -progress output
# is streamed and turned into a MEASURED percentage (encoded seconds /
# total seconds) that the page polls; at 100% the page downloads the file.
_burn_jobs = {}
_burn_jobs_lock = threading.Lock()


def _get_burn_job(job_id):
    with _burn_jobs_lock:
        job = _burn_jobs.get(job_id)
        if job is None:
            return None
        if job["finished_at"] and time.time() - job["finished_at"] > JOB_TTL_SECONDS:
            shutil.rmtree(job["tmp"], ignore_errors=True)
            del _burn_jobs[job_id]
            return None
        return job


def _burn_view(job):
    return {
        "ok": True,
        "job_id": job["id"],
        "status": job["status"],
        "progress_percentage": job["progress"],
        "message": job["message"],
        "error": job["error"],
    }


def _run_burn_job(job, video_path, srt_path, out_path, vf, tmp):
    try:
        duration = probe_duration(video_path)
        cmd = [
            "ffmpeg", "-y", "-v", "error", "-i", str(video_path),
            "-vf", vf,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats",
            str(out_path),
        ]
        print(f"[burn] start job {job['id'][:8]} duration={duration}", flush=True)
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        job["proc"] = proc
        assert proc.stdout is not None
        for line in proc.stdout:
            if job["cancel"].is_set():
                proc.terminate()
                break
            if line.startswith("out_time_us=") and duration > 0:
                try:
                    done_s = int(line.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                pct = int(max(0.0, min(99.0, done_s / duration * 100)))
                if pct != job["progress"]:
                    with _burn_jobs_lock:
                        job["progress"] = pct
                        job["message"] = f"Rendering your captioned video\u2026 {pct}%"
        proc.wait(timeout=1800)
        err_tail = ""
        try:
            err_tail = (proc.stderr.read() or "")[-300:] if proc.stderr else ""
        except Exception:
            pass
        with _burn_jobs_lock:
            if job["cancel"].is_set():
                job.update(status="cancelled", message="Rendering cancelled.")
            elif proc.returncode == 0 and out_path.exists():
                job.update(status="completed", progress=100,
                           message="Your captioned video is ready.")
            else:
                job.update(status="failed",
                           message="Rendering failed.",
                           error="ffmpeg could not burn the captions into that video. " + err_tail)
            job["finished_at"] = time.time()
        print(f"[burn] job {job['id'][:8]} -> {job['status']}", flush=True)
    except Exception as exc:
        with _burn_jobs_lock:
            job.update(status="failed", message="Rendering failed.",
                       error=f"Rendering failed: {exc}",
                       finished_at=time.time())


@app.post("/api/burn-jobs")
def create_burn_job(
    file: UploadFile = File(...),
    srt: str = Form(...),
    fontsize: int = Form(24),
    color: str = Form("#ffffff"),
    position: str = Form("bottom"),
    cues_json: str = Form(""),
    highlight: str = Form(""),
    karaoke: str = Form(""),
    bg: str = Form(""),
    font_px: int = Form(0),
):
    if not srt.strip():
        return json_error("No SRT content was provided.")
    tmp = Path(tempfile.mkdtemp(prefix="captionai-burnjob-"))
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    video_path = tmp / f"input{suffix}"
    try:
        size = save_upload(file, video_path)
    except ValueError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        return json_error(str(exc), status=413)
    if size == 0:
        shutil.rmtree(tmp, ignore_errors=True)
        return json_error("The uploaded file was empty.")
    srt_path, vf = _choose_subs(tmp, video_path, srt, fontsize, color, position,
                                cues_json=cues_json, highlight=highlight,
                                karaoke=karaoke, bg=bg, font_px=font_px)
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id, "status": "processing", "progress": 0,
        "message": "Rendering your captioned video\u2026",
        "error": None, "created_at": time.time(), "finished_at": None,
        "cancel": threading.Event(), "proc": None, "tmp": tmp,
        "out_path": tmp / "captioned.mp4",
    }
    with _burn_jobs_lock:
        _burn_jobs[job_id] = job
    threading.Thread(
        target=_run_burn_job,
        args=(job, video_path, srt_path, job["out_path"], vf, tmp),
        daemon=True).start()
    return {"ok": True, "job_id": job_id, "status": "processing"}


@app.get("/api/burn-jobs/{job_id}")
def get_burn_job(job_id: str):
    job = _get_burn_job(job_id)
    if job is None:
        return json_error("Render job not found \u2014 it may have expired (finished renders are kept for about 30 minutes).", status=404)
    return _burn_view(job)


@app.post("/api/burn-jobs/{job_id}/cancel")
def cancel_burn_job(job_id: str):
    job = _get_burn_job(job_id)
    if job is None:
        return json_error("Render job not found \u2014 it may have expired.", status=404)
    if job["status"] == "processing":
        job["cancel"].set()
        if job.get("proc") is not None:
            try:
                job["proc"].terminate()
            except Exception:
                pass
    return _burn_view(job)


@app.get("/api/burn-jobs/{job_id}/file")
def get_burn_file(job_id: str):
    job = _get_burn_job(job_id)
    if job is None:
        return json_error("Render job not found \u2014 it may have expired.", status=404)
    if job["status"] != "completed" or not job["out_path"].exists():
        return json_error("The captioned video is not ready yet.", status=409)
    return FileResponse(job["out_path"], media_type="video/mp4",
                        filename="captioned-video.mp4")


@app.post("/api/burn")
def burn(
    file: UploadFile = File(...),
    srt: str = Form(...),
    fontsize: int = Form(24),
    color: str = Form("#ffffff"),
    position: str = Form("bottom"),
    cues_json: str = Form(""),
    highlight: str = Form(""),
    karaoke: str = Form(""),
    bg: str = Form(""),
    font_px: int = Form(0),
):
    if not srt.strip():
        return json_error("No SRT content was provided.")
    tmp = Path(tempfile.mkdtemp(prefix="captionai-burn-"))
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    video_path = tmp / f"input{suffix}"
    try:
        size = save_upload(file, video_path)
    except ValueError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        return json_error(str(exc), status=413)
    if size == 0:
        shutil.rmtree(tmp, ignore_errors=True)
        return json_error("The uploaded file was empty.")

    srt_path, vf = _choose_subs(tmp, video_path, srt, fontsize, color, position,
                                cues_json=cues_json, highlight=highlight,
                                karaoke=karaoke, bg=bg, font_px=font_px)
    out_path = tmp / "captioned.mp4"
    # ultrafast: on CPU-capped free tiers (e.g. Render free = 0.15 CPU) the
    # encode is the bottleneck; veryfast made short burns exceed any sane
    # client timeout. ultrafast is several times faster at a larger file size.
    ok, err = run([
        "ffmpeg", "-y", "-v", "error", "-i", str(video_path),
        "-vf", vf,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        str(out_path),
    ], timeout=1500)
    if not ok or not out_path.exists():
        shutil.rmtree(tmp, ignore_errors=True)
        return json_error("ffmpeg could not burn the captions into that video. " + err, status=422)

    return FileResponse(
        out_path,
        media_type="video/mp4",
        filename="captioned-video.mp4",
        background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True),
    )


# ------------------------------------------------------- static frontend ---
# Mounted LAST so /health and /api/* always win over the static files.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
