import os
import uuid
import re
from pathlib import Path

import certifi

os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

BASE_DIR = Path(__file__).parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

REEL_PATTERN = re.compile(r"https?://(?:www\.)?instagram\.com/reels?/[\w-]+", re.I)

app = FastAPI(title="Instoob")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/videos", StaticFiles(directory=str(DOWNLOAD_DIR)), name="videos")


class DownloadRequest(BaseModel):
    url: str


class DownloadResponse(BaseModel):
    video_url: str
    title: str | None = None
    uploader: str | None = None
    description: str | None = None


@app.post("/download", response_model=DownloadResponse)
def download_reel(req: DownloadRequest):
    if not REEL_PATTERN.search(req.url):
        raise HTTPException(status_code=400, detail="Not a valid Instagram Reel URL")

    job_id = uuid.uuid4().hex
    outtmpl = str(DOWNLOAD_DIR / f"{job_id}.%(ext)s")

    ydl_opts = {
        "outtmpl": outtmpl,
        "format": "mp4/best",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }

    cookies_path = BASE_DIR / "ig_cookies.txt"
    if cookies_path.exists():
        ydl_opts["cookiefile"] = str(cookies_path)

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(req.url, download=True)
            filename = ydl.prepare_filename(info)
    except DownloadError as e:
        raise HTTPException(status_code=502, detail=f"Download failed: {e}")

    final_path = Path(filename)
    if not final_path.exists():
        mp4 = final_path.with_suffix(".mp4")
        if mp4.exists():
            final_path = mp4
        else:
            raise HTTPException(status_code=500, detail="Downloaded file missing")

    return DownloadResponse(
        video_url=f"/videos/{final_path.name}",
        title=info.get("title"),
        uploader=info.get("uploader"),
        description=info.get("description"),
    )


@app.get("/")
def root():
    return {"ok": True}
