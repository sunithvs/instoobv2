import os
import re
import uuid
from pathlib import Path

import certifi

import config

os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")  # localhost http callback

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from auth import require_session, router as auth_router
from db import init_db

REEL_PATTERN = re.compile(r"https?://(?:www\.)?instagram\.com/reels?/[\w-]+", re.I)

app = FastAPI(title="Instoob")

app.add_middleware(
    SessionMiddleware,
    secret_key=config.SESSION_SECRET,
    same_site="lax",
    https_only=False,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[config.FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/videos", StaticFiles(directory=str(config.DOWNLOAD_DIR)), name="videos")

app.include_router(auth_router)


@app.on_event("startup")
def _startup() -> None:
    init_db()


class DownloadRequest(BaseModel):
    url: str


class DownloadResponse(BaseModel):
    video_url: str
    title: str | None = None
    uploader: str | None = None
    description: str | None = None


@app.post("/download", response_model=DownloadResponse)
def download_reel(req: DownloadRequest, _: str = Depends(require_session)):
    if not REEL_PATTERN.search(req.url):
        raise HTTPException(status_code=400, detail="Not a valid Instagram Reel URL")

    job_id = uuid.uuid4().hex
    outtmpl = str(config.DOWNLOAD_DIR / f"{job_id}.%(ext)s")

    ydl_opts = {
        "outtmpl": outtmpl,
        "format": "mp4/best",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }

    cookies_path = Path(config.IG_COOKIES_PATH)
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
