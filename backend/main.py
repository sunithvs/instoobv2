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

from auth import get_credentials, require_session, router as auth_router
from db import init_db
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

REEL_PATTERN = re.compile(r"https?://(?:www\.)?instagram\.com/reels?/[\w-]+", re.I)
HASHTAG_PATTERN = re.compile(r"#(\w+)")
MAX_SHORT_SECONDS = 60

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
    filename: str
    duration: float | None = None
    title: str | None = None
    uploader: str | None = None
    description: str | None = None
    instagram_url: str


class UploadRequest(BaseModel):
    filename: str
    instagram_url: str
    uploader: str | None = None
    caption: str | None = None


class UploadResponse(BaseModel):
    youtube_video_id: str
    youtube_url: str


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
        filename=final_path.name,
        duration=info.get("duration"),
        title=info.get("title"),
        uploader=info.get("uploader"),
        description=info.get("description"),
        instagram_url=req.url,
    )


def _build_youtube_metadata(caption: str | None, uploader: str | None, source_url: str):
    cap = (caption or "").strip()
    if cap:
        first_line = cap.replace("\r", "").split("\n", 1)[0].strip()
        title = (first_line or cap)[:70].strip() or f"Reel by @{uploader or 'unknown'}"
        attribution = f"\n\nOriginally posted by @{uploader or 'unknown'} on Instagram: {source_url}"
        description = f"{cap}{attribution}\n\n#Shorts"
    else:
        title = f"Reel by @{uploader or 'unknown'}"
        description = f"{source_url}\n\n#Shorts"
    tags = list({h.lower() for h in HASHTAG_PATTERN.findall(cap)})[:30]
    return title, description, tags


@app.post("/upload", response_model=UploadResponse)
def upload_to_youtube(req: UploadRequest, _: str = Depends(require_session)):
    safe_name = Path(req.filename).name
    file_path = config.DOWNLOAD_DIR / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    title, description, tags = _build_youtube_metadata(
        req.caption, req.uploader, req.instagram_url
    )

    try:
        creds = get_credentials()
        yt = build("youtube", "v3", credentials=creds, cache_discovery=False)
        media = MediaFileUpload(
            str(file_path), mimetype="video/mp4", resumable=True, chunksize=-1
        )
        body = {
            "snippet": {
                "title": title,
                "description": description,
                "tags": tags,
                "categoryId": "22",
            },
            "status": {
                "privacyStatus": "public",
                "selfDeclaredMadeForKids": False,
            },
        }
        request_yt = yt.videos().insert(
            part="snippet,status", body=body, media_body=media
        )
        response = None
        while response is None:
            _status, response = request_yt.next_chunk()
        video_id = response["id"]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"YouTube upload failed: {e}")
    finally:
        try:
            file_path.unlink(missing_ok=True)
        except Exception:
            pass

    return UploadResponse(
        youtube_video_id=video_id,
        youtube_url=f"https://youtube.com/shorts/{video_id}",
    )


@app.get("/")
def root():
    return {"ok": True}
