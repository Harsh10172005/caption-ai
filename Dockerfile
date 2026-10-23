# Caption AI — one container: FastAPI backend + static frontend.
#   docker build -t caption-ai .
#   docker run -p 8000:8000 caption-ai
# Then open http://localhost:8000 — upload a video, captions come back.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY . /app

ENV WHISPER_MODEL=tiny \
    PYTHONUNBUFFERED=1
# HF Spaces sets PORT=7860, Render/Railway set their own; default 8000.
CMD ["sh", "-c", "uvicorn app:app --app-dir backend --host 0.0.0.0 --port ${PORT:-8000}"]
