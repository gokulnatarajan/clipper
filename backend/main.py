import os
import uuid
import subprocess
import threading
from pathlib import Path

import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

app = FastAPI(title="Clipper API")

FRONTEND_URL = os.environ.get("FRONTEND_URL", "")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL] if FRONTEND_URL else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CLIPS_DIR = Path("clips")
CLIPS_DIR.mkdir(exist_ok=True)

jobs: dict = {}


class ProcessURLRequest(BaseModel):
    url: str
    clip_length: int = 30
    top_n: int = 10
    vertical: bool = True


def _update(job_id: str, **kwargs):
    if job_id in jobs:
        jobs[job_id].update(kwargs)


def _extract_rms(video_path: str, chunk_dur: float = 2.0):
    """Stream mono 16 kHz PCM from ffmpeg and return RMS per chunk."""
    sr = 16_000
    chunk_samples = int(sr * chunk_dur)
    chunk_bytes = chunk_samples * 4  # f32le = 4 bytes per sample

    proc = subprocess.Popen(
        [
            "ffmpeg", "-i", video_path,
            "-vn", "-ac", "1", "-ar", str(sr),
            "-f", "f32le", "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    rms_list = []
    buf = b""
    while True:
        data = proc.stdout.read(chunk_bytes * 8)
        if not data:
            break
        buf += data
        while len(buf) >= chunk_bytes:
            chunk = np.frombuffer(buf[:chunk_bytes], dtype=np.float32)
            buf = buf[chunk_bytes:]
            rms_list.append(float(np.sqrt(np.mean(chunk ** 2))))
    proc.wait()

    return np.array(rms_list, dtype=np.float32), chunk_dur


def _detect_highlights(rms: np.ndarray, chunk_dur: float, clip_length: int, top_n: int):
    win = max(1, int(clip_length / chunk_dur))
    sep = max(1, int(60 / chunk_dur))
    if len(rms) < win:
        return []

    scores = np.array([rms[i : i + win].mean() for i in range(len(rms) - win + 1)])
    max_s = scores.max()
    normed = scores / max_s if max_s > 0 else scores.copy()

    used = np.zeros(len(scores), dtype=bool)
    picks = []
    for _ in range(top_n):
        avail = np.where(~used)[0]
        if not len(avail):
            break
        idx = int(avail[scores[avail].argmax()])
        picks.append({"start": float(idx * chunk_dur), "score": float(normed[idx])})
        used[max(0, idx - sep) : idx + sep + 1] = True

    return sorted(picks, key=lambda x: x["start"])


def _cut_clip(src: str, start: float, dur: int, dst: str, vertical: bool):
    vf_args = ["-vf", "scale=-2:1920,crop=1080:1920"] if vertical else []
    subprocess.run(
        [
            "ffmpeg", "-ss", str(start), "-i", src,
            "-t", str(dur),
            *vf_args,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            "-y", dst,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _process(job_id: str, video_path: str, clip_length: int, top_n: int, vertical: bool, cleanup: bool = False):
    try:
        job_dir = CLIPS_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        _update(job_id, status="analyzing", progress=0.1, message="Analyzing audio")
        rms, chunk_dur = _extract_rms(video_path)

        if not len(rms):
            _update(job_id, status="error", error="Could not read audio from video")
            return

        _update(job_id, progress=0.3, message="Detecting highlights")
        highlights = _detect_highlights(rms, chunk_dur, clip_length, top_n)

        if not highlights:
            _update(job_id, status="error", error="No highlights detected — video may be silent")
            return

        _update(job_id, status="extracting", progress=0.4, message="Cutting clips")
        clips = []
        for i, h in enumerate(highlights):
            name = f"clip_{i + 1:02d}_{int(h['start'])}s.mp4"
            _cut_clip(video_path, h["start"], clip_length, str(job_dir / name), vertical)
            clips.append({
                "filename": name,
                "start": h["start"],
                "score": h["score"],
                "url": f"/clips/{job_id}/{name}",
            })
            _update(job_id, progress=0.4 + 0.58 * (i + 1) / len(highlights), clips=list(clips))

        _update(job_id, status="done", progress=1.0, message="Done", clips=clips)

    except Exception as exc:
        _update(job_id, status="error", error=str(exc))
    finally:
        if cleanup and os.path.exists(video_path):
            os.remove(video_path)


def _download_and_process(job_id: str, url: str, clip_length: int, top_n: int, vertical: bool):
    try:
        job_dir = CLIPS_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        _update(job_id, status="downloading", progress=0.05, message="Downloading VOD")
        tmpl = str(job_dir / "video.%(ext)s")

        result = subprocess.run(
            ["yt-dlp", "-o", tmpl, "--no-playlist", url],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            _update(job_id, status="error", error=f"Download failed: {result.stderr[:500]}")
            return

        files = [f for f in job_dir.glob("video.*") if f.suffix != ".part"]
        if not files:
            _update(job_id, status="error", error="Downloaded file not found")
            return

        _process(job_id, str(files[0]), clip_length, top_n, vertical, cleanup=True)

    except Exception as exc:
        _update(job_id, status="error", error=str(exc))


def _spawn(target, *args):
    threading.Thread(target=target, args=args, daemon=True).start()


@app.post("/api/process-url")
async def process_url(req: ProcessURLRequest):
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "queued", "progress": 0.0, "clips": [], "error": None, "message": "Queued"}
    _spawn(_download_and_process, job_id, req.url, req.clip_length, req.top_n, req.vertical)
    return {"job_id": job_id}


@app.post("/api/process-file")
async def process_file(
    file: UploadFile = File(...),
    clip_length: int = Form(30),
    top_n: int = Form(10),
    vertical: bool = Form(True),
):
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "uploading", "progress": 0.02, "clips": [], "error": None, "message": "Uploading"}

    job_dir = CLIPS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "upload.mp4").suffix or ".mp4"
    video_path = str(job_dir / f"upload{suffix}")
    with open(video_path, "wb") as f:
        f.write(await file.read())

    _spawn(_process, job_id, video_path, clip_length, top_n, vertical, True)
    return {"job_id": job_id}


@app.get("/api/job/{job_id}")
async def get_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]


@app.get("/clips/{job_id}/{filename}")
async def serve_clip(job_id: str, filename: str, download: bool = False):
    path = CLIPS_DIR / job_id / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Clip not found")
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'} if download else {}
    return FileResponse(str(path), media_type="video/mp4", headers=headers, filename=filename)
