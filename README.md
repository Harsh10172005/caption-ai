# Caption AI

A Hinglish-first caption editor for talking-head videos. Upload a clip, transcribe its Hindi + English (Hinglish) audio, edit the captions, style them, and export. The frontend is a single page of vanilla HTML/CSS/JS, and there is now a **real backend** (`backend/`, FastAPI + faster-whisper + FFmpeg) that does what hosted tools do: **upload a video → captions are generated on the server → a captioned MP4 comes back — no API key, no pasting scripts.**

> This is an original project. It is inspired by the general workflow of AI caption tools (upload → transcribe → edit → export), but all copy, design, and code here are written from scratch.

## Features

- **Landing + app in one page** — hero, 3-step explainer, language chips (Hinglish, Hindi, English, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Urdu, and more), pricing, and FAQ.
- **Video player** — drag & drop or pick an MP4/WebM file, shown in a 9:16-style stage with a live caption overlay.
- **Three ways to get captions**
  1. **Whisper (optional, bring your own key)** — paste your OpenAI API key and the app calls `POST https://api.openai.com/v1/audio/transcriptions` with model `whisper-1`, `verbose_json`, word timestamps, `temperature 0` for consistent results, and a prompt that biases the result toward Roman-script Hinglish.
  2. **Script mode (no key)** — paste your script/transcript and the editor auto-splits it into timed cues based on the video's duration and word count.
  3. **Built-in demo** — one click loads a Hinglish demo transcript with timed cues, so the editor works instantly with no video and no key.
- **Caption editor** — click a cue to seek to it, edit its text inline, delete or add cues. The overlay and exports update live.
- **SRT import** — bring captions in from another tool with **Import SRT** (in the Edit captions panel). The file is parsed into cues with word timings split evenly across each cue, ready to restyle, preview, and burn in.
- **Autosave** — your caption cues and style settings save automatically to your browser's `localStorage` on every change and are restored when you reopen the page. The OpenAI API key is **never** saved — it lives only in page memory.
- **Karaoke highlight** — the current word is highlighted as the video plays, based on word timing.
- **Style controls** — presets (Clean, Bold Yellow, High Energy, Minimal), font-size slider, text and highlight colour pickers, background-box toggle, position (bottom / middle / top), and karaoke toggle.
- **Exports**
  - `captions.srt` — standard subtitle file.
  - `captions-words.srt` — one cue per word, for karaoke-style editing elsewhere.
  - `captioned-video.webm` — burned-in captions, rendered in-browser with `canvas.captureStream()` + `MediaRecorder` (works in Chrome; renders in real time).

## Run locally

No build step. Either:

```bash
# Option 1: just open the file
open index.html        # macOS
xdg-open index.html    # Linux

# Option 2: serve it (recommended — some browsers are stricter about local files)
cd caption-ai
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a repository (for example `caption-ai`) and push these files to the root of the `main` branch:
   ```
   index.html
   styles.css
   app.js
   README.md
   ```
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, and save.
4. Your site will be published at `https://<your-username>.github.io/caption-ai/` within a minute or two.

Because the app is fully static, GitHub Pages hosting is free and sufficient. Do not commit any API key — the app never needs one baked in.

## Backend — auto-captioning with NO key (the Headroom-style flow)

A static web page cannot transcribe audio or burn MP4s by itself; that work needs a server. `backend/app.py` is that server:

- `GET  /health` → `{"ok": true, "provider": ..., "model": ...}`
- `POST /api/transcribe` — multipart video upload. FFmpeg extracts the audio, **faster-whisper runs on the server**, and the API returns `{duration, language, cues:[{start,end,text,words}], srt}` with word-level timings. The editor's **Auto-caption my video** button uses this and fills the cues in automatically.
- `POST /api/burn` — multipart video + SRT + style fields (fontsize, color, position). FFmpeg's `subtitles` filter burns the captions in and the API returns a real **captioned MP4** — the **Export MP4 (backend)** button.
- The backend also serves the static frontend at `/`, so **one service is the whole product**. CORS is open (demo), videos up to 300 MB are accepted by default (`MAX_UPLOAD_MB`) — a ~1–2 minute VN Editor export at high bitrate can be 250 MB+, and the cap leaves headroom. Uploads are **streamed to disk in chunks (never loaded into RAM)**, and **only the extracted audio is used for transcription** — the video file itself is processed at full original quality for caption burn-in, never downscaled. The one real cost of a big file is upload time, which depends on the user's connection and the hosting (on the same network it's seconds; over the internet, a 300 MB upload takes as long as any 300 MB upload). Temp files are deleted after each request.
- One dependency gotcha, already handled in `backend/requirements.txt`: PyAV 15+ removed the `metadata_errors` argument that faster-whisper's audio decoder passes, so `av` is pinned to `14.2.0` — without the pin, every transcription fails with a TypeError.

### Run it locally

```bash
cd backend
pip install -r requirements.txt   # needs Python 3.10+ and ffmpeg on PATH
uvicorn app:app --host 0.0.0.0 --port 8000
# open http://localhost:8000 — pick a video, press "Auto-caption my video"
```

The frontend can also run separately (GitHub Pages etc.): put the backend's URL in the **Backend URL** field in the editor. Leave it empty when the page came from the backend itself.

First transcription downloads the Whisper model (`tiny` ≈ 75 MB). `tiny` is fast; set `WHISPER_MODEL=base` or `small` for noticeably better Hinglish accuracy at the cost of speed.

### Transcription provider: local Whisper **or** OpenRouter

| Env var | Default | Meaning |
|---|---|---|
| `TRANSCRIBE_PROVIDER` | `local` | `local` = faster-whisper on this server (free, private, no limits beyond your hardware). `openrouter` = extract audio to MP3 and send it to OpenRouter's STT API. |
| `OPENROUTER_API_KEY` | — | Required in `openrouter` mode. Use a key with OpenRouter credits — STT usage is billed to your OpenRouter account. |
| `OPENROUTER_STT_MODEL` | `openai/whisper-1` | Model slug for OpenRouter mode. |
| `WHISPER_MODEL` | `tiny` | Model size for local mode. |
| `MAX_UPLOAD_MB` | `300` | Upload guard (backend accepts large VN/phone exports up to 300 MB). |

**Honest OpenRouter caveats** (from OpenRouter's official STT docs): the endpoint is OpenAI-compatible (`POST https://openrouter.ai/api/v1/audio/transcriptions`, `verbose_json` gives words/segments), **but it ignores the `prompt` field** — so the Roman-script Hinglish biasing that local mode and direct OpenAI mode apply does *not* work there, and Hindi is more likely to come back in Devanagari script. OpenRouter's own multipart cap is **25 MB**, but in backend mode that applies to the *extracted MP3*, not your video: the backend compresses the audio to mono MP3 first, and if even that exceeds ~24 MB (roughly 50+ minutes of audio) it automatically **splits the MP3 into chunks with ffmpeg, transcribes them in order, and re-offsets the word timestamps** — so a 300 MB / long video still works end-to-end. If Roman Hinglish matters most, prefer local mode (the prompt works because faster-whisper takes `initial_prompt`) — OpenRouter mode is a convenience for servers too small to run Whisper.

The **frontend's key-based mode** now has the same choice: the *Direct transcription provider* dropdown switches between **OpenAI** and **OpenRouter** (model `openai/whisper-1`). Your key stays in page memory only, for either provider.

### Deploy the backend

- **Docker (any host):** a `Dockerfile` at the repo root builds the whole service (FFmpeg + backend + frontend). `docker build -t caption-ai . && docker run -p 8000:8000 caption-ai`. Set env vars with `-e`, e.g. `-e WHISPER_MODEL=base` or `-e TRANSCRIBE_PROVIDER=openrouter -e OPENROUTER_API_KEY=...`.
- **Hugging Face Spaces:** create a Docker Space from this repo — the Dockerfile honours the `PORT` env var (Spaces uses 7860). Free CPU Spaces can run the `tiny`/`base` models.
- **Render / Railway:** create a Web Service from the repo using the Dockerfile (or Python runtime with start command `uvicorn app:app --app-dir backend --host 0.0.0.0 --port $PORT`), and set the env vars above in the dashboard. Pick an instance with enough RAM for the model (≥1 GB for `tiny`, more for larger models).

Once deployed, GitHub Pages can stay as the free frontend — just point its **Backend URL** field at your deployed backend. Or skip Pages entirely and use the backend's own hosting of the frontend.

## Whisper key usage & privacy

- The OpenAI API key field is **optional**. Without it, script mode and the demo work fully.
- If you enter a key, it is held **only in page memory** while the tab is open. It is never written to `localStorage`, cookies, logs, or any server other than OpenAI's transcription endpoint, which receives it as the `Authorization` header for your request.
- Your video stays on your device **except** when you explicitly press **Transcribe with Whisper** — at that point the file is sent directly from your browser to OpenAI.
- OpenAI's transcription endpoint accepts files up to **25 MB**. The app warns you if your selected file is larger and will block the Whisper request in that case; trim/compress the clip or use script mode instead.
- Costs, if any, are charged by OpenAI to the account that owns the key you paste. Check OpenAI's current pricing for `whisper-1`.

## Browser notes

- Use a recent **Chrome** (or Chromium/Edge) for the burned-in video export — it relies on `canvas.captureStream` and `MediaRecorder` with WebM.
- Video export renders **in real time** (a 60-second clip takes ~60 seconds) and includes the original audio. The audio graph is created once and reused, so you can export more than once in the same session and every export keeps its audio. If audio capture is blocked, the export still completes as video-only.
- One known WebM quirk: files recorded with `MediaRecorder` carry no duration in their header (`ffprobe` shows `duration: N/A`), even though the content itself is full length — players compute the length from the frames. Remuxing with `ffmpeg -i captioned-video.webm -c copy out.webm` writes a duration if a tool insists on one.
- SRT timestamps are computed from total rounded milliseconds, so fractions that round up (e.g. 59.9996s) correctly become `00:01:00,000`, never `,1000`.
- SRT exports and the caption editor work in all modern browsers.

## Testing

The core flow is verified end-to-end in a real (headless Chromium) browser, not just by reading the code. Last verified 2026-10-23, using a generated 6-second 360×640 test video (colour + tone track, made with FFmpeg):

| Test | Result |
|---|---|
| Load demo → caption cues created, first cue is the Hinglish demo text | ✅ 17 cues |
| Paste a script → cues auto-timed | ✅ 4 cues from a 19-word paragraph |
| Load the test video (duration reads 6.00s) → export SRT | ✅ valid `HH:MM:SS,mmm` timestamps, script words present |
| Import that SRT back → cues recreated | ✅ 4 cues, same first cue |
| Export video with burned-in captions | ✅ ~169 KB WebM, content spans ~6.0s, audio track present (Opus) |
| Export a **second** time in the same session | ✅ ~168 KB WebM, ~6.0s, audio present |
| Reload the page → autosaved captions restored | ✅ all cues restored |

Manual equivalent: serve the folder (`python3 -m http.server 8000`), open the page in Chrome, click **Load Hinglish demo transcript**, load any short MP4, use **Create captions from script**, download the SRT and open it in a text editor, re-import it with **Import SRT**, then **Export video with captions** and play the downloaded `.webm`. Reload the page — your captions should still be there.

### Backend & size-limit tests (2026-10-23)

Verified against the real FastAPI backend with a synthesized Hindi speech clip (Piper TTS: "यार सुनो, आज मैं आपको एक सिंपल ट्रिक बताने वाला हूं, ये बहुत काम की है"):

| Test | Result |
|---|---|
| `POST /api/transcribe` (local tiny model) | ✅ `language: "hi"`, 5.48s, Roman-script output: *"Yaar suno, aaj main aapko ek simple trick batane wala hoon…"* (7/9 key words; the tiny model mishears the tail — use `WHISPER_MODEL=base`/`small` for production quality) |
| `POST /api/burn` | ✅ MP4 back, H.264+AAC; frame diff at a caption moment: 18.8% of bottom-strip pixels changed (captions really burned in) |
| **257 MB** 1080×1920 / 80s padded VN-style MP4 → transcribe | ✅ Accepted (not size-rejected), transcribed, `duration: 80.016` |
| Same 257 MB file → `/api/burn` | ✅ Captioned MP4 back in ~33s, 1080×1920 H.264+AAC |
| Upload over the limit | ✅ HTTP 413 with a clear JSON error (`"File is over the N MB upload limit."`), verified via a 1 MB-limit instance (same guard code as the 300 MB default) |
| OpenRouter request construction (mocked HTTP, no real key) | ✅ Correct URL, `Bearer` auth from env, `openai/whisper-1`, `verbose_json`, word+segment granularities, no `prompt` field sent |
| OpenRouter **chunking** (mocked HTTP) | ✅ A 28 MB / 1800s MP3 was auto-split into 2 calls (18.3 MB + 9.2 MB, both < 24 MB cap), later-chunk word timestamps correctly offset (max start 1200.5s), total duration 1799.8s |

Not yet done: a *live* OpenRouter/OpenAI API test (needs a real, funded key) — both are verified only at the request/response-shape level with mocks.

Naive-user browser flow (Playwright + real backend, 2026-10-23): **8/8 passed** — fresh page has no pricing section → upload shows "NEXT STEP → generate captions" guidance → Export with no captions gives a loud, scrolling error instead of silently doing nothing → **Auto-caption** creates 3 cues (language `hi`) → caption text visible on the video overlay during playback → **Export MP4 (backend)** downloads a valid 5.48s MP4 → browser WebM export still downloads too.

## Roadmap

- ~~Backend Whisper service so users don't need their own key~~ — **done** (see Backend section; upload limits included, queueing still to come).
- ~~MP4 export via a server-side FFmpeg worker~~ — **done** (`/api/burn`).
- Job queue + progress polling for long videos on the backend.
- Devanagari ⇄ Roman transliteration toggle for Hindi/Hinglish captions.
- VTT import (SRT import is done).
- Auto punch-in / zoom, silence trimming, and speaker labels.
- More Indian language presets and fonts.

## Project structure

```
caption-ai/
├── index.html          # Landing page + editor markup
├── styles.css          # All styling, caption themes, responsive layout
├── app.js              # Player, transcription, cue editor, karaoke, styling, exports
├── backend/
│   ├── app.py          # FastAPI service: /api/transcribe, /api/burn, serves the frontend
│   └── requirements.txt
├── Dockerfile          # Whole product in one container
└── README.md           # This file
```

## License

Free to use and modify for your own projects.
