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

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
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


def _openrouter_transcribe_file(mp3_path, language):
    """One OpenRouter call for one MP3 file. Returns the parsed JSON."""
    return _post_multipart(OPENROUTER_URL, _openrouter_fields(language), "file",
                           Path(mp3_path).name, Path(mp3_path).read_bytes(),
                           {"Authorization": "Bearer " + OPENROUTER_API_KEY})


def transcribe_with_openrouter(audio_mp3_path, language, work_dir=None):
    """Transcribe an extracted MP3 via OpenRouter, chunking if needed.

    The *video* can be up to the 300 MB backend limit — that doesn't matter
    to OpenRouter, because only the extracted mono MP3 is sent. If even the
    MP3 is over the provider's 25 MB cap (roughly >50 min of speech), it is
    split with ffmpeg's segment muxer into <24 MB chunks, each chunk is
    transcribed in order, and the word timestamps are shifted by the
    cumulative chunk offsets before the cues are rebuilt.
    Returns (cues, duration, language)."""
    if not OPENROUTER_API_KEY:
        raise RuntimeError("TRANSCRIBE_PROVIDER=openrouter but OPENROUTER_API_KEY is not set on the server.")
    audio_mp3_path = Path(audio_mp3_path)
    if audio_mp3_path.stat().st_size <= OPENROUTER_MAX_BYTES:
        return api_json_to_result(_openrouter_transcribe_file(audio_mp3_path, language))

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
        data = _openrouter_transcribe_file(chunk_file, language)
        for w in _extract_words(data):
            all_words.append({"word": w["word"],
                              "start": round(w["start"] + offset, 3),
                              "end": round(w["end"] + offset, 3)})
        detected = detected or data.get("language")
        offset += probe_duration(chunk_file) or float(data.get("duration") or chunk_seconds)
    return words_to_cues(all_words), round(offset, 3), detected


# ---------------------------------------------------------------- API ------
@app.get("/health")
def health():
    return {
        "ok": True,
        "provider": PROVIDER,
        "model": OPENROUTER_STT_MODEL if PROVIDER == "openrouter" else MODEL_NAME,
        "model_loaded": _model is not None,
    }


@app.post("/api/transcribe")
def transcribe(file: UploadFile = File(...), language: str = Form("")):
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

        if PROVIDER == "openrouter":
            mp3_path = tmp / "audio.mp3"
            ok, err = run([
                "ffmpeg", "-y", "-v", "error", "-i", str(video_path),
                "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-q:a", "4",
                str(mp3_path),
            ])
            if not ok:
                return json_error("ffmpeg could not extract audio from that file. Is it a valid video? " + err, status=422)
            try:
                cue_list, duration, detected = transcribe_with_openrouter(mp3_path, lang, work_dir=tmp)
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


@app.post("/api/burn")
def burn(
    file: UploadFile = File(...),
    srt: str = Form(...),
    fontsize: int = Form(24),
    color: str = Form("#ffffff"),
    position: str = Form("bottom"),
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

    srt_path = tmp / "subs.srt"
    srt_path.write_text(srt, encoding="utf-8")
    out_path = tmp / "captioned.mp4"

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
    vf = f"subtitles={srt_path}:force_style='{force_style}'"
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
