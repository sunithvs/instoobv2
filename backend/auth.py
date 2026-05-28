from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from sqlmodel import select

import crypto
from config import (
    ALLOWED_EMAIL,
    FRONTEND_ORIGIN,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    GOOGLE_SCOPES,
)
from db import OAuthToken, get_session

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_config() -> dict:
    return {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [GOOGLE_REDIRECT_URI],
        }
    }


def _build_flow(state: Optional[str] = None) -> Flow:
    flow = Flow.from_client_config(
        _client_config(), scopes=GOOGLE_SCOPES, state=state
    )
    flow.redirect_uri = GOOGLE_REDIRECT_URI
    return flow


def _load_token() -> Optional[OAuthToken]:
    with get_session() as s:
        return s.exec(select(OAuthToken).where(OAuthToken.provider == "google")).first()


def require_session(request: Request) -> str:
    email = request.session.get("email")
    if not email or email.lower() != ALLOWED_EMAIL:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return email


def get_credentials() -> Credentials:
    tok = _load_token()
    if not tok:
        raise HTTPException(status_code=401, detail="YouTube not connected")
    refresh_token = crypto.decrypt(tok.refresh_token_enc)
    return Credentials(
        token=None,
        refresh_token=refresh_token,
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        token_uri="https://oauth2.googleapis.com/token",
        scopes=GOOGLE_SCOPES,
    )


@router.get("/google/login")
def login(request: Request):
    flow = _build_flow()
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    request.session["oauth_state"] = state
    request.session["oauth_code_verifier"] = flow.code_verifier
    return RedirectResponse(auth_url)


@router.get("/google/callback")
def callback(request: Request, code: str, state: Optional[str] = None):
    saved_state = request.session.pop("oauth_state", None)
    code_verifier = request.session.pop("oauth_code_verifier", None)
    if saved_state and state and saved_state != state:
        raise HTTPException(status_code=400, detail="OAuth state mismatch")

    flow = _build_flow(state=saved_state)
    if code_verifier:
        flow.code_verifier = code_verifier
    flow.fetch_token(code=code)
    creds: Credentials = flow.credentials

    if not creds.refresh_token:
        raise HTTPException(
            status_code=400,
            detail="No refresh token returned. Revoke app in Google account and retry.",
        )

    oauth_service = build("oauth2", "v2", credentials=creds, cache_discovery=False)
    userinfo = oauth_service.userinfo().get().execute()
    email = (userinfo.get("email") or "").lower()

    if email != ALLOWED_EMAIL:
        raise HTTPException(
            status_code=403,
            detail=f"Email {email} not in allowlist",
        )

    yt = build("youtube", "v3", credentials=creds, cache_discovery=False)
    ch_resp = yt.channels().list(part="snippet", mine=True).execute()
    items = ch_resp.get("items", [])
    channel_id = items[0]["id"] if items else None
    channel_title = items[0]["snippet"]["title"] if items else None

    enc = crypto.encrypt(creds.refresh_token)
    with get_session() as s:
        existing = s.exec(
            select(OAuthToken).where(OAuthToken.provider == "google")
        ).first()
        if existing:
            existing.refresh_token_enc = enc
            existing.channel_id = channel_id
            existing.channel_title = channel_title
            existing.email = email
            existing.updated_at = datetime.utcnow()
            s.add(existing)
        else:
            s.add(
                OAuthToken(
                    provider="google",
                    refresh_token_enc=enc,
                    channel_id=channel_id,
                    channel_title=channel_title,
                    email=email,
                )
            )
        s.commit()

    request.session["email"] = email
    return RedirectResponse(FRONTEND_ORIGIN)


@router.get("/status")
def status(request: Request):
    email = request.session.get("email")
    authenticated = bool(email) and email.lower() == ALLOWED_EMAIL
    tok = _load_token() if authenticated else None
    return {
        "authenticated": authenticated,
        "email": email if authenticated else None,
        "connected": tok is not None,
        "channel_title": tok.channel_title if tok else None,
        "channel_id": tok.channel_id if tok else None,
    }


@router.post("/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}
