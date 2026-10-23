# Caption AI

A static, Hinglish-first caption editor for talking-head videos. Upload a clip, transcribe its Hindi + English (Hinglish) audio, edit the captions, style them, and export — all from a single page with **vanilla HTML, CSS, and JavaScript. No build step, no backend, no dependencies.**

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

## Roadmap

- Backend Whisper service so users don't need their own key (with upload limits and queueing).
- Devanagari ⇄ Roman transliteration toggle for Hindi/Hinglish captions.
- VTT import (SRT import is done).
- Auto punch-in / zoom, silence trimming, and speaker labels.
- MP4 export via a server-side FFmpeg worker.
- More Indian language presets and fonts.

## Project structure

```
caption-ai/
├── index.html   # Landing page + editor markup
├── styles.css   # All styling, caption themes, responsive layout
├── app.js       # Player, transcription, cue editor, karaoke, styling, exports
└── README.md    # This file
```

## License

Free to use and modify for your own projects.
