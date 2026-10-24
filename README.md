# Caption AI

**Automatic Roman Hinglish captions for talking-head videos — upload a video, get a captioned MP4 back.**

🔗 **Live:** https://caption-ai-ukit.onrender.com
💻 **Stack:** Vanilla HTML/CSS/JS · FastAPI · Google Gemini API · FFmpeg/libass · Docker on Render

Caption AI transcribes Hindi + English (Hinglish) speech into Roman-script captions, lets you edit and style them with a live karaoke preview, and burns them into the video exactly as previewed — same size, same colours, word-by-word highlight sweep.

> This is an original project. It is inspired by the general workflow of AI caption tools (upload → transcribe → edit → export), but all copy, design, and code here are written from scratch.

## How it works

1. **Upload** — drag & drop an MP4/WebM (up to 300 MB). Nothing else to configure.
2. **Processing** — the server extracts the audio and transcribes it with the Gemini API using a Roman-Hinglish prompt with structured (JSON schema) output. A job system tracks real progress — current stage, elapsed time, cancel, and retry — and survives a page refresh.
3. **Edit & style** — captions open in an editor with a live preview: click a cue to seek, edit text inline, adjust font size, text/highlight colours, background box, and position. The current word highlights karaoke-style as the video plays.
4. **Download** — the MP4 is rendered on the server as a tracked job with live progress. The burn uses a styled ASS subtitle rendered at the video's real resolution (karaoke `\kf` sweep, true pixel font size, both colours), so **the download matches the preview** — no size blow-up, no flattened colours.

Your work autosaves in the browser (captions + style, never any API key), so a refresh or a closed tab offers **Resume** instead of starting over. The original video is never returned without captions.

## Features

- **Deliberately simple 3-screen flow** — upload → processing → captioned video. Advanced options (provider choice, own API key) are tucked away, out of the main flow.
- **Transcription providers** — Gemini (default; free-tier friendly, 1–3s segments aligned to pauses), optional local faster-whisper, optional OpenRouter. Selected via environment variable or per-request override.
- **Real job tracking** — `POST /api/jobs` returns a job id; the UI polls measured progress (actual transcription stages), supports cancel, retry with the same file, and re-attaching after a refresh.
- **Karaoke captions** — word-level timings drive both the live preview highlight and the burned-in sweep.
- **Styled MP4 export** — FFmpeg + libass render job (`POST /api/burn-jobs`) with progress %, auto-download on completion; also exports `captions.srt` and a word-per-cue SRT.
- **Robust media handling** — uploads are streamed (300 MB cap), video dimensions are probed via a multi-strategy cascade (ffprobe JSON → CSV scan → ffmpeg banner, rotation-aware), and burns log exactly which subtitle path was taken — silent fallbacks are treated as bugs.
- **No stale frontends** — the app is served with `Cache-Control: no-cache`, so a fix is never hidden behind a cached page.

## Project structure

```
index.html / app.js / styles.css   # single-page frontend (no build step)
backend/app.py                     # FastAPI backend: jobs, transcription, burn-in
backend/requirements.txt
Dockerfile                         # FFmpeg + Python image used on Render
render.yaml                        # Render blueprint (auto-deploy on push to main)
```

The frontend is also mirrored on GitHub Pages (https://harsh10172005.github.io/caption-ai/), where it talks to the same Render backend.

## Run locally

```bash
# Frontend only: just open index.html, or serve it
python3 -m http.server 8000

# Backend (transcription + MP4 burn)
cd backend
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8123
```

## Configuration (environment variables)

| Variable | Purpose |
| --- | --- |
| `TRANSCRIBE_PROVIDER` | `gemini` (default on the live deploy), `local` (faster-whisper), or `openrouter` |
| `GEMINI_API_KEY` | Google AI Studio key for Gemini transcription (server-side only, never in the repo) |
| `GEMINI_MODEL` | Defaults to `gemini-3.8-flash` |
| `WHISPER_MODEL` | faster-whisper model size for the local provider (e.g. `tiny`) |

Users can also bring their own key per job from the site's **Advanced options** — it stays in page memory and is never stored.

## Notes & limitations

- The live demo runs on Render's free tier: it **sleeps when idle** (first visit can take ~1 minute to wake) and has a small CPU, so a ~1-minute video takes a few minutes to caption and render.
- On the Gemini free tier, transcription is subject to Google's daily quota.
- Word timings inside a Gemini segment are evenly estimated between the segment's start and end.

## License

Personal portfolio project by Harsh Pathak — feel free to explore the code.
