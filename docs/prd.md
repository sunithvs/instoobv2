# PRD: Reel-to-Shorts Uploader

**Owner:** Sunith
**Status:** Draft v1
**Last updated:** 2026-05-28

---

## 1. Overview

A personal, single-user web application that takes an Instagram Reel URL, downloads the video, extracts its caption/hashtags as metadata, and uploads it to the owner's connected YouTube channel as a YouTube Short.

The product removes the manual "download → trim → re-encode → fill metadata → upload" loop and reduces it to a single paste-and-submit action.

## 2. Goals and non-goals

### Goals

The system should let the operator paste a single Instagram Reel URL and, with no further input, produce a published YouTube Short on the connected channel. It should reuse the original caption and hashtags as the YouTube title, description, and tags so the uploader does not have to retype anything. It must handle YouTube OAuth once and persist the refresh token so day-to-day use is frictionless.

### Non-goals (MVP)

The MVP does not support multiple users, multiple source platforms (no TikTok, Facebook, or YouTube Shorts as a source), batch uploads, scheduling, watermark removal, thumbnail customization, AI-rewritten metadata, or analytics. These are explicitly deferred to a v2 backlog so the MVP can ship.

## 3. Target user and use case

There is exactly one user: the owner of the YouTube channel. The typical session is short — open the site, paste a Reel link, click Upload, wait for confirmation with a link to the published Short, close the tab.

## 4. User stories

1. **As the operator**, I can connect my YouTube channel once via Google OAuth so the app gets permission to upload videos on my behalf.
2. **As the operator**, I can paste an Instagram Reel URL into a single text input and click "Upload to YouTube".
3. **As the operator**, I see a status indicator (downloading → processing → uploading → done) so I know what stage the job is in.
4. **As the operator**, on success I see the YouTube Shorts URL of my newly uploaded video and can click through to it.
5. **As the operator**, on failure I see a clear human-readable error (e.g., "Instagram returned a private-account error" or "YouTube quota exceeded") so I know what went wrong and what to do.

## 5. Functional requirements

### 5.1 Authentication

Google OAuth 2.0 with the `youtube.upload` scope. The refresh token is stored encrypted in the backend database. Because this is a single-user app, the app does not need login/signup screens for end users — the owner's Google account is the only authorized identity, enforced by an allowlist of one email (`sunith@latelogic.com`).

### 5.2 Input

A single web page with one form field: `instagram_url`. Basic client-side validation that the URL matches an Instagram Reel pattern (`instagram.com/reel/...` or `instagram.com/reels/...`). On submit, the URL is sent to the backend.

### 5.3 Download

The backend uses `yt-dlp` to fetch the Reel as an MP4. Because Instagram increasingly requires authentication to view reels reliably, the backend keeps a Netscape-format Instagram cookies file (`ig_cookies.txt`) on disk and passes `--cookies` to yt-dlp. yt-dlp also returns metadata in JSON form — the caption (`description`), hashtags, uploader handle, and original URL.

### 5.4 Metadata extraction

From the yt-dlp JSON the backend extracts:
- **Title:** first ~70 characters of the caption (YouTube title cap is 100, but Shorts work best short). Strip newlines.
- **Description:** the full caption, with a trailing line: `Originally posted by @<uploader> on Instagram: <reel_url>`.
- **Tags:** every hashtag (`#word`) parsed out of the caption, stripped of the `#`.
- **Privacy:** `public` (configurable in env later).
- **Category:** `22` (People & Blogs) by default.
- **`madeForKids`:** `false`.

If the caption is empty, fall back to title = `Reel by @<uploader>` and description = the source URL only.

### 5.5 YouTube upload

Use Google's YouTube Data API v3 `videos.insert` endpoint with resumable upload. To have YouTube classify the video as a **Short**, the title or description should include `#Shorts`, and the source video must be vertical and ≤ 60 seconds. The backend appends `#Shorts` to the description automatically.

If the source video is longer than 60s, the MVP rejects it with a clear error rather than auto-trimming.

### 5.6 Status reporting

The submit endpoint returns a `job_id` immediately. The frontend polls `GET /jobs/{job_id}` every 2 seconds and renders the current stage:
`queued → downloading → uploading → completed | failed`.
On `completed`, the response includes `youtube_url`. On `failed`, it includes `error_message`.

### 5.7 Cleanup

The downloaded MP4 is deleted from disk immediately after the YouTube upload finishes (success or failure). No source video is retained.

## 6. Non-functional requirements

The app is for personal use, so concurrency and scale are minimal — at most one job at a time is fine. A request should complete end-to-end in under 90 seconds for a typical 30-second reel. The site should be HTTPS-only. Secrets (Google client secret, encryption key for refresh token, Instagram cookies) live in environment variables on the VPS, never in the frontend bundle or git.

## 7. Architecture

### 7.1 Components

- **Frontend** — React SPA, deployed to Cloudflare Pages. Communicates with the backend over HTTPS at a subdomain like `api.<your-domain>`.
- **Backend** — Python (FastAPI is recommended over Django for this app — it is async-friendly, lightweight, and the API surface is small). Runs on a VPS behind a reverse proxy (Caddy or Nginx).
- **Worker** — A simple in-process background task (FastAPI `BackgroundTasks` or `asyncio` task) is sufficient for a single-user app; no Celery/Redis needed for MVP.
- **Database** — SQLite file on the VPS. Holds one row in `oauth_tokens` (the YouTube refresh token, encrypted) and a `jobs` table for status tracking. Postgres is overkill for one user.
- **Storage** — Local `/tmp` on the VPS for the in-flight MP4. Auto-deleted after upload.

### 7.2 Request flow

```
[ React on CF Pages ]
        |
        | 1. POST /jobs { instagram_url }
        v
[ FastAPI on VPS ]
        |
        | 2. yt-dlp --cookies ig_cookies.txt <url> -o /tmp/<job_id>.mp4
        |    (and dump metadata json)
        v
[ Local /tmp/<job_id>.mp4 ]
        |
        | 3. YouTube Data API videos.insert (resumable upload)
        v
[ YouTube ]
        |
        | 4. youtube_url returned
        v
[ Update jobs.status = completed, jobs.youtube_url = ... ]
        |
        | 5. Frontend polls GET /jobs/{job_id} and renders result
```

### 7.3 API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/auth/google/login` | Redirect to Google OAuth consent screen |
| GET | `/auth/google/callback` | Exchange code for tokens, persist refresh token |
| GET | `/auth/status` | Returns `{ connected: bool, channel_title: str }` |
| POST | `/jobs` | Body `{ instagram_url }`. Returns `{ job_id }`. Kicks off background task. |
| GET | `/jobs/{job_id}` | Returns `{ status, stage, youtube_url?, error_message? }` |

All endpoints other than the OAuth ones require a session cookie tied to the single allowlisted email.

### 7.4 Data model

```
oauth_tokens
  id                  INTEGER PK
  provider            TEXT     -- "google"
  refresh_token_enc   BLOB     -- AES-GCM encrypted
  channel_id          TEXT
  channel_title       TEXT
  updated_at          TIMESTAMP

jobs
  id                  TEXT PK  -- uuid
  instagram_url       TEXT
  status              TEXT     -- queued | downloading | uploading | completed | failed
  stage_detail        TEXT     -- free-text current step
  youtube_video_id    TEXT NULL
  error_message       TEXT NULL
  created_at          TIMESTAMP
  completed_at        TIMESTAMP NULL
```

## 8. Tech stack summary

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | React + Vite, hosted on Cloudflare Pages | Lightweight SPA, free hosting on CF |
| Backend | Python 3.12 + FastAPI | Async, small surface, plays well with yt-dlp |
| Downloader | `yt-dlp` (Python lib) | Free, well-maintained, supports cookies |
| Auth | `google-auth` + `google-auth-oauthlib` | Official Google libs |
| YouTube upload | `google-api-python-client` | Official, supports resumable upload |
| DB | SQLite + SQLModel (or SQLAlchemy) | Zero ops |
| Reverse proxy | Caddy (auto-HTTPS) | One config file, Let's Encrypt built-in |
| Process manager | systemd unit | Standard on Linux VPS |

## 9. Setup requirements

The operator must, before first use:
1. Create a Google Cloud project, enable the YouTube Data API v3, configure an OAuth consent screen (in **Testing** mode is fine for one user), and create OAuth 2.0 credentials (Web application). Add `https://api.<domain>/auth/google/callback` as a redirect URI.
2. Export Instagram cookies from a logged-in browser session (using a browser extension like "Get cookies.txt LOCALLY") and place the resulting `ig_cookies.txt` on the VPS at a known path. Refresh this file when Instagram invalidates the session (typically every few weeks).
3. Set environment variables on the VPS: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENC_KEY`, `IG_COOKIES_PATH`, `ALLOWED_EMAIL`, `FRONTEND_ORIGIN`.

## 10. Risks and mitigations

The largest risk is Instagram blocking downloads. Instagram regularly tightens scraping defenses, and even with cookies, yt-dlp can break overnight when the page structure changes. Mitigation: keep yt-dlp updated (`pip install -U yt-dlp` on a cron), keep a fresh cookie file, and surface the exact downloader error to the UI so the operator can diagnose quickly. As a fallback path documented in v2, integrate a paid Instagram-scraping API (e.g., RapidAPI providers).

The second risk is YouTube API quota. Each `videos.insert` costs 1,600 quota units against the default daily quota of 10,000 — so the app can do ~6 uploads per day per project before exhausting quota. For one-user MVP this is acceptable; if more is needed, request a quota increase from Google.

The third risk is OAuth consent screen status. While the OAuth app is in "Testing" mode, refresh tokens expire after 7 days. For sustained personal use, either keep re-authorizing weekly or push the app to "Production" status (which for upload scope requires Google's security review — possible but a multi-week process).

The fourth, smaller risk is the Shorts classification heuristic. YouTube's classification of what is and isn't a Short is opaque. Mitigation: ensure vertical orientation passes through unchanged from Instagram (yt-dlp preserves it), keep videos ≤60s, and always include `#Shorts` in the description.

## 11. Milestones

**Milestone 1 — Auth + skeleton (Day 1–2):** FastAPI scaffold, SQLite, Google OAuth round-trip working, refresh token persisted, `/auth/status` returns the channel title.

**Milestone 2 — Download pipeline (Day 3):** `POST /jobs` accepts a URL, kicks off yt-dlp with cookies, writes the file to `/tmp`, extracts caption/hashtags. Verified by hitting the endpoint and seeing the MP4 + JSON on disk.

**Milestone 3 — Upload pipeline (Day 4):** Resumable upload to YouTube using the stored refresh token, returns the video ID, marks the job completed. Verified by an actual upload appearing on the channel.

**Milestone 4 — Frontend (Day 5):** Single-page React UI — "Connect YouTube" button if not connected; URL input + Upload button if connected; polling status with progress and the final Shorts link.

**Milestone 5 — Deploy (Day 6):** Push backend to VPS behind Caddy with HTTPS, push React build to Cloudflare Pages, CORS configured. End-to-end smoke test from the live site.

## 12. Open questions

1. Should the app preview the reel (thumbnail + caption) before the operator confirms the upload, or is a single click sufficient? Current PRD assumes single click.
2. What happens if YouTube classifies the upload as a regular video, not a Short? Currently no recourse — accept it.
3. Long-term, should jobs persist across server restarts (currently they would, via SQLite) or should the worker resume in-flight uploads? MVP assumes any in-flight job at restart is marked failed.

## 13. Out of scope / v2 backlog

Batch upload, scheduled posting, multi-user support, TikTok/Facebook/YouTube sources, watermark removal, AI-generated titles and descriptions, custom thumbnails, upload history dashboard with analytics, automatic monitoring of an Instagram account for new reels.
