import { useEffect, useState, type FormEvent } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'

type DownloadResponse = {
  video_url: string
  filename: string
  duration: number | null
  title: string | null
  uploader: string | null
  description: string | null
  instagram_url: string
}

type UploadResponse = {
  youtube_video_id: string
  youtube_url: string
}

type GeneratedCaption = {
  title: string
  description: string
  tags: string[]
}

type AuthStatus = {
  authenticated: boolean
  email: string | null
  connected: boolean
  channel_title: string | null
  channel_id: string | null
}

type HistoryItem = {
  id: number
  instagram_url: string
  uploader: string | null
  title: string | null
  youtube_video_id: string | null
  youtube_url: string | null
  status: 'success' | 'failed' | string
  error_message: string | null
  created_at: string
}

const MAX_SHORT_SECONDS = 60

function App() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DownloadResponse | null>(null)

  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null)

  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<GeneratedCaption | null>(null)

  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])

  async function fetchHistory() {
    try {
      const res = await fetch(`${API_BASE}/uploads`, { credentials: 'include' })
      if (!res.ok) return
      setHistory(await res.json())
    } catch {
      // ignore
    }
  }

  async function fetchAuth() {
    try {
      const res = await fetch(`${API_BASE}/auth/status`, { credentials: 'include' })
      setAuth(await res.json())
    } catch {
      setAuth({ authenticated: false, email: null, connected: false, channel_title: null, channel_id: null })
    }
  }

  useEffect(() => {
    fetchAuth()
  }, [])

  useEffect(() => {
    if (auth?.authenticated) fetchHistory()
  }, [auth?.authenticated])

  async function onLogout() {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' })
    fetchAuth()
  }

  function resetUploadState() {
    setUploadError(null)
    setUploadResult(null)
    setGenError(null)
    setGenerated(null)
  }

  async function onGenerate() {
    if (!result) return
    setGenError(null)
    setGenerating(true)
    try {
      const res = await fetch(`${API_BASE}/generate-caption`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caption: result.description,
          uploader: result.uploader,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Generation failed')
      setGenerated(data)
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setResult(null)
    resetUploadState()
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/download`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Download failed')
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function onUpload() {
    if (!result) return
    resetUploadState()
    setUploading(true)
    try {
      const res = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: result.filename,
          instagram_url: result.instagram_url,
          uploader: result.uploader,
          caption: result.description,
          title: generated?.title,
          description: generated?.description,
          tags: generated?.tags,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Upload failed')
      setUploadResult(data)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
      fetchHistory()
    }
  }

  function formatDate(iso: string) {
    const d = new Date(iso)
    return d.toLocaleString()
  }

  const tooLong =
    result?.duration != null && result.duration > MAX_SHORT_SECONDS

  return (
    <main className="container">
      <header className="header">
        <h1>Instoob</h1>
        {auth?.authenticated ? (
          <div className="account">
            <span>{auth.channel_title ?? auth.email}</span>
            <button type="button" onClick={onLogout}>Logout</button>
          </div>
        ) : null}
      </header>

      {!auth ? (
        <p>Loading…</p>
      ) : !auth.authenticated ? (
        <div className="connect">
          <p>Connect your YouTube channel to start.</p>
          <a className="btn-primary" href={`${API_BASE}/auth/google/login`}>
            Connect YouTube
          </a>
        </div>
      ) : (
        <>
          <p className="subtitle">Paste an Instagram Reel URL to download.</p>
          <form onSubmit={onSubmit} className="form">
            <input
              type="url"
              required
              placeholder="https://www.instagram.com/reel/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
            />
            <button type="submit" disabled={loading || !url}>
              {loading ? 'Downloading…' : 'Download'}
            </button>
          </form>

          {error && <div className="error">Error: {error}</div>}

          {result && (
            <div className="result">
              {result.title && <h2>{result.title}</h2>}
              {result.uploader && <p className="uploader">@{result.uploader}</p>}
              {result.duration != null && (
                <p className="meta">Duration: {Math.round(result.duration)}s</p>
              )}
              <video
                src={`${API_BASE}${result.video_url}`}
                controls
                playsInline
                style={{ maxWidth: '100%', maxHeight: '70vh' }}
              />
              <p>
                <a href={`${API_BASE}${result.video_url}`} download>
                  Download MP4
                </a>
              </p>

              {uploadResult ? (
                <div className="success">
                  Uploaded.{' '}
                  <a href={uploadResult.youtube_url} target="_blank" rel="noreferrer">
                    Open on YouTube
                  </a>
                </div>
              ) : (
                <>
                  <div className="upload-row">
                    <button
                      type="button"
                      onClick={onGenerate}
                      disabled={generating}
                    >
                      {generating
                        ? 'Generating…'
                        : generated
                          ? 'Regenerate caption'
                          : 'Generate caption'}
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={onUpload}
                      disabled={uploading || tooLong}
                    >
                      {uploading ? 'Uploading to YouTube…' : 'Upload to YouTube'}
                    </button>
                    {tooLong && (
                      <span className="warn">
                        Video longer than {MAX_SHORT_SECONDS}s — not a Short.
                      </span>
                    )}
                  </div>

                  {genError && <div className="error">Error: {genError}</div>}

                  {generated && (
                    <div className="generated">
                      <label>
                        Title
                        <input
                          type="text"
                          maxLength={100}
                          value={generated.title}
                          onChange={(e) =>
                            setGenerated({ ...generated, title: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        Description
                        <textarea
                          rows={6}
                          value={generated.description}
                          onChange={(e) =>
                            setGenerated({ ...generated, description: e.target.value })
                          }
                        />
                      </label>
                      {generated.tags.length > 0 && (
                        <p className="tags">{generated.tags.map((t) => `#${t}`).join(' ')}</p>
                      )}
                    </div>
                  )}
                </>
              )}

              {uploadError && <div className="error">Error: {uploadError}</div>}

              {!generated && result.description && (
                <pre className="caption">{result.description}</pre>
              )}
            </div>
          )}

          <section className="history">
            <div className="history-head">
              <h3>Upload history</h3>
              <button type="button" className="refresh" onClick={fetchHistory}>
                Refresh
              </button>
            </div>
            {history.length === 0 ? (
              <p className="muted">No uploads yet.</p>
            ) : (
              <ul className="history-list">
                {history.map((h) => (
                  <li key={h.id} className={`history-item ${h.status}`}>
                    <div className="history-row">
                      <span className={`pill ${h.status}`}>{h.status}</span>
                      <span className="history-title">
                        {h.title ?? h.instagram_url}
                      </span>
                      <span className="history-date">{formatDate(h.created_at)}</span>
                    </div>
                    <div className="history-row history-meta">
                      {h.uploader && <span>@{h.uploader}</span>}
                      <a href={h.instagram_url} target="_blank" rel="noreferrer">
                        Reel
                      </a>
                      {h.youtube_url && (
                        <a href={h.youtube_url} target="_blank" rel="noreferrer">
                          YouTube
                        </a>
                      )}
                    </div>
                    {h.error_message && (
                      <div className="history-error">{h.error_message}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  )
}

export default App
