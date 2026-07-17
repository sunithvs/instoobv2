import json
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

from datetime import datetime

from sqlmodel import select

from auth import get_credentials, require_session, router as auth_router
from db import Upload, get_session, init_db
from llm import LLMError, get_provider
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
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/videos", StaticFiles(directory=str(config.DOWNLOAD_DIR)), name="videos")

app.include_router(auth_router)


@app.on_event("startup")
def _startup() -> None:
    init_db()
    print(f"[config] GOOGLE_REDIRECT_URI = {config.GOOGLE_REDIRECT_URI}", flush=True)
    print(f"[config] FRONTEND_ORIGIN     = {config.FRONTEND_ORIGIN}", flush=True)
    print(f"[config] CORS_ORIGINS        = {config.CORS_ORIGINS}", flush=True)


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
    title: str | None = None
    description: str | None = None
    tags: list[str] | None = None


class UploadResponse(BaseModel):
    youtube_video_id: str
    youtube_url: str


class GenerateCaptionRequest(BaseModel):
    caption: str | None = None
    uploader: str | None = None


class GenerateCaptionResponse(BaseModel):
    title: str
    description: str
    tags: list[str]


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


YOUTUBE_SYSTEM_PROMPT = (
    "You are a YouTube Shorts optimization expert. Rewrite an Instagram reel "
    "caption into metadata that performs well on YouTube. Swap Instagram "
    "vocabulary for YouTube equivalents (follow -> subscribe, link in bio -> "
    "link in description, reel -> video, double tap -> like, DM -> comment, "
    "save this post -> save this video). Do NOT mention Instagram or the "
    "original creator. Return strict JSON with keys: "
    '"title" (string, <=100 chars, keyword-rich), '
    '"description" (string, ending with a "Like & Subscribe" call to action '
    'and the "#Shorts" tag), '
    '"tags" (array of <=30 lowercase keyword strings).'
)


def _fallback_metadata(caption: str | None, uploader: str | None):
    cap = (caption or "").strip()
    if cap:
        first_line = cap.replace("\r", "").split("\n", 1)[0].strip()
        title = (first_line or cap)[:100].strip() or f"Video by @{uploader or 'unknown'}"
        description = f"{cap}\n\n#Shorts"
    else:
        title = f"Video by @{uploader or 'unknown'}"
        description = "#Shorts"
    tags = list({h.lower() for h in HASHTAG_PATTERN.findall(cap)})[:30]
    return title, description, tags


def _build_youtube_metadata(caption: str | None, uploader: str | None):
    provider = get_provider()
    if provider is None:
        return _fallback_metadata(caption, uploader)

    try:
        raw = provider.generate(
            system=YOUTUBE_SYSTEM_PROMPT,
            prompt=(caption or "").strip() or f"A short video by @{uploader or 'unknown'}",
            json_mode=True,
        )
        data = json.loads(raw)
        title = str(data["title"]).strip()[:100]
        description = str(data["description"]).strip()
        tags = [str(t).lower().strip() for t in data.get("tags", []) if str(t).strip()][:30]
        if not title or not description:
            raise ValueError("empty title/description from LLM")
        return title, description, tags
    except (LLMError, json.JSONDecodeError, KeyError, ValueError, TypeError):
        return _fallback_metadata(caption, uploader)


def _record_upload(
    *,
    instagram_url: str,
    uploader: str | None,
    title: str | None,
    youtube_video_id: str | None,
    status: str,
    error_message: str | None,
) -> None:
    with get_session() as s:
        s.add(
            Upload(
                instagram_url=instagram_url,
                uploader=uploader,
                title=title,
                youtube_video_id=youtube_video_id,
                status=status,
                error_message=error_message,
            )
        )
        s.commit()


@app.post("/upload", response_model=UploadResponse)
def upload_to_youtube(req: UploadRequest, _: str = Depends(require_session)):
    safe_name = Path(req.filename).name
    file_path = config.DOWNLOAD_DIR / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if req.title and req.description:
        title = req.title[:100]
        description = req.description
        tags = [t.lower().strip() for t in (req.tags or []) if t.strip()][:30]
    else:
        title, description, tags = _build_youtube_metadata(req.caption, req.uploader)

    video_id: str | None = None
    error: str | None = None
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
    except HTTPException as e:
        error = e.detail if isinstance(e.detail, str) else str(e.detail)
        _record_upload(
            instagram_url=req.instagram_url,
            uploader=req.uploader,
            title=title,
            youtube_video_id=None,
            status="failed",
            error_message=error,
        )
        raise
    except Exception as e:
        error = f"YouTube upload failed: {e}"
        _record_upload(
            instagram_url=req.instagram_url,
            uploader=req.uploader,
            title=title,
            youtube_video_id=None,
            status="failed",
            error_message=error,
        )
        raise HTTPException(status_code=502, detail=error)
    finally:
        try:
            file_path.unlink(missing_ok=True)
        except Exception:
            pass

    _record_upload(
        instagram_url=req.instagram_url,
        uploader=req.uploader,
        title=title,
        youtube_video_id=video_id,
        status="success",
        error_message=None,
    )

    return UploadResponse(
        youtube_video_id=video_id,
        youtube_url=f"https://youtube.com/shorts/{video_id}",
    )


@app.post("/generate-caption", response_model=GenerateCaptionResponse)
def generate_caption(req: GenerateCaptionRequest, _: str = Depends(require_session)):
    title, description, tags = _build_youtube_metadata(req.caption, req.uploader)
    return GenerateCaptionResponse(title=title, description=description, tags=tags)


class UploadHistoryItem(BaseModel):
    id: int
    instagram_url: str
    uploader: str | None
    title: str | None
    youtube_video_id: str | None
    youtube_url: str | None
    status: str
    error_message: str | None
    created_at: datetime


@app.get("/uploads", response_model=list[UploadHistoryItem])
def list_uploads(_: str = Depends(require_session), limit: int = 50):
    with get_session() as s:
        rows = s.exec(
            select(Upload).order_by(Upload.created_at.desc()).limit(limit)
        ).all()
    return [
        UploadHistoryItem(
            id=r.id,
            instagram_url=r.instagram_url,
            uploader=r.uploader,
            title=r.title,
            youtube_video_id=r.youtube_video_id,
            youtube_url=(
                f"https://youtube.com/shorts/{r.youtube_video_id}"
                if r.youtube_video_id
                else None
            ),
            status=r.status,
            error_message=r.error_message,
            created_at=r.created_at,
        )
        for r in rows
    ]


@app.get("/")
def root():
    return {"ok": True}
