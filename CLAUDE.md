# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Clipper** is a two-service app that downloads Twitch/Kick VODs (or accepts uploads) and auto-clips them into 9:16 TikTok-ready segments using audio-energy highlight detection. No AI/ML — pure RMS-based analysis via numpy + ffmpeg.

## Services

| Service | Directory | Port |
|---|---|---|
| FastAPI backend | `backend/` | 8000 |
| Next.js 14 frontend | `frontend/` | 3000 |

Both are deployed as independent Railway services, each with its own Dockerfile.

## Development commands

### Backend
```bash
cd backend
pip install -r requirements.txt       # needs ffmpeg + yt-dlp on PATH
uvicorn main:app --reload --port 8000
```

### Frontend
```bash
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
npm run build && npm start            # production build
npm run lint
```

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | frontend build-time | Backend URL (Railway sets this as a build arg — baked in at `npm run build`) |
| `FRONTEND_URL` | backend runtime | Allowed CORS origin; defaults to `*` if unset |

**Railway note:** `NEXT_PUBLIC_API_URL` must be set as a build argument in Railway's frontend service settings, not just a runtime env var, because Next.js bakes it at build time.

## Architecture

### Backend (`backend/main.py`)
Single-file FastAPI app. All state is an in-memory `jobs` dict (fine for single-user use — no persistence across restarts).

Each job runs in a daemon `threading.Thread` so the FastAPI event loop stays unblocked. Job lifecycle:
1. `POST /api/process-url` → spawns `_download_and_process` (yt-dlp → `_process`)
2. `POST /api/process-file` → saves upload → spawns `_process`
3. `_process` → `_extract_rms` (ffmpeg pipe → numpy) → `_detect_highlights` (greedy sliding window) → `_cut_clip` × N

Audio is never written to disk — ffmpeg pipes raw `f32le` PCM directly into numpy via `stdout=subprocess.PIPE`.

Clip files are saved under `clips/{job_id}/clip_NN_Xs.mp4` and served via `GET /clips/{job_id}/{filename}`. Add `?download=true` to get a `Content-Disposition: attachment` header (needed for cross-origin downloads).

### Frontend (`frontend/app/page.tsx`)
Single `"use client"` page. No routing beyond `/`. State flow:
- Submit form → POST to backend → receive `job_id`
- Poll `GET /api/job/{job_id}` every 1.5s via `setTimeout` (stored in `pollRef`)
- Clips render as they appear in the `clips[]` array (backend updates it incrementally)
- Download uses fetch → Blob URL trick to force download across origins

### Highlight detection algorithm
1. Pipe audio through ffmpeg as mono 16 kHz f32le
2. Compute RMS over 2-second non-overlapping chunks
3. Sliding window average over `clip_length`-sized windows → score per start time
4. Greedy selection: pick highest-scoring window, mask out ±60s, repeat up to `top_n` times
5. Normalize scores 0.0–1.0 relative to max

### Clip extraction
`ffmpeg -ss <start> -i <src> -t <dur> -vf scale=-2:1920,crop=1080:1920 -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart`

`-ss` before `-i` = fast keyframe seek. Vertical crop disabled when `vertical=false` (no `-vf`).
