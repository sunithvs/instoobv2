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

const FAQS: { q: string; a: string }[] = [
  {
    q: 'Is Instoob free?',
    a: "Yes. It's open source and self-hosted — you run it on your own machine. The only cost is your own OpenAI usage if you turn on AI caption rewriting.",
  },
  {
    q: 'Does Instoob store my videos or my channel access?',
    a: 'No. Everything runs locally. Reels download to your machine and are deleted right after upload, and your Google tokens stay inside your own session — nothing is sent to a third party.',
  },
  {
    q: 'Which links work?',
    a: 'Any public Instagram Reel URL. Paste it and Instoob fetches the MP4 instantly.',
  },
  {
    q: 'Will it actually post as a Short?',
    a: 'Yes — if the clip is 60 seconds or under and vertical, YouTube treats it as a Short. Instoob uploads it to your channel with an optimized title, description, and tags.',
  },
  {
    q: 'Do I need an OpenAI key?',
    a: 'Only for AI caption rewriting. Without one, Instoob falls back to your original caption cleaned up for YouTube — swapping Instagram wording for YouTube equivalents.',
  },
]

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
  const [openFaq, setOpenFaq] = useState<number | null>(0)

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
        <div className="logo">
          <span className="logo-mark">▶</span>
          <span className="logo-word">Instoob</span>
        </div>
        {auth?.authenticated ? (
          <div className="account">
            <span>{auth.channel_title ?? auth.email}</span>
            <button type="button" onClick={onLogout}>Logout</button>
          </div>
        ) : auth ? (
          <a className="nav-connect" href={`${API_BASE}/auth/google/login`}>
            Connect YouTube
          </a>
        ) : null}
      </header>

      {!auth ? (
        <p>Loading…</p>
      ) : !auth.authenticated ? (
        <div className="landing">
          <section className="hero">
            <div className="hero-copy">
              <span className="eyebrow">Open source</span>
              <h2 className="hero-title">
                Turn your Reels into <span className="hl">YouTube Shorts</span>.
              </h2>
              <p className="hero-sub">
                Paste an Instagram Reel link. Instoob downloads it, rewrites the
                caption for YouTube with AI, and publishes it as a Short — in
                one click.
              </p>
              <a className="btn-primary" href={`${API_BASE}/auth/google/login`}>
                Connect YouTube ↗
              </a>
              <p className="hero-note">
                Free · Self-hosted · Your channel tokens never leave your machine
              </p>
            </div>

            <div className="hero-visual">
              <div className="device">
                <div className="device-head">
                  <span className="device-chip ig">Reel</span>
                  <span className="device-handle">@creator</span>
                </div>
                <div className="device-thumb">
                  <span className="play">▶</span>
                </div>
                <div className="device-convert">
                  <span>AI optimize</span>
                  <span className="device-arrow">↓</span>
                </div>
                <div className="device-out">
                  <span className="device-chip yt">Short</span>
                  <p className="device-title">
                    5 AI Tools You Need to Try in 2025
                  </p>
                  <p className="device-tags">#shorts · #ai · #tools</p>
                </div>
              </div>
            </div>
          </section>

          <section className="features" id="features">
            <span className="eyebrow">Features</span>
            <h3 className="section-title">
              Everything to repost. Nothing you don't.
            </h3>
            <div className="feature-grid">
              <div className="feature-card">
                <span className="feature-icon">⬇</span>
                <h4>One-tap download</h4>
                <p>Paste any Reel URL — Instoob grabs the raw video instantly.</p>
              </div>
              <div className="feature-card hl">
                <span className="feature-icon">✦</span>
                <h4>AI caption rewrite</h4>
                <p>
                  Title, description, and tags rewritten to rank and convert on
                  YouTube.
                </p>
              </div>
              <div className="feature-card">
                <span className="feature-icon">↺</span>
                <h4>Smart vocabulary swap</h4>
                <p>
                  "follow" → "subscribe", "link in bio" → "link in description".
                  Automatically.
                </p>
              </div>
              <div className="feature-card">
                <span className="feature-icon">⚡</span>
                <h4>One-click publish</h4>
                <p>Uploads straight to your channel as a Short. No re-encoding.</p>
              </div>
            </div>
          </section>

          <section className="steps" id="how">
            <span className="eyebrow">How it works</span>
            <h3 className="section-title">Three steps. One click.</h3>
            <div className="step-grid">
              <div className="step-card">
                <span className="step-num">01</span>
                <h4>Connect your channel</h4>
                <p>
                  Sign in with Google and authorize YouTube upload. Takes ten
                  seconds.
                </p>
              </div>
              <div className="step-card">
                <span className="step-num">02</span>
                <h4>Paste a Reel link</h4>
                <p>
                  Drop any Instagram Reel URL. Instoob fetches the video
                  instantly.
                </p>
              </div>
              <div className="step-card">
                <span className="step-num">03</span>
                <h4>Optimize & publish</h4>
                <p>
                  AI rewrites the title, description, and tags for YouTube. One
                  click uploads it as a Short.
                </p>
              </div>
            </div>
          </section>

          <section className="why" id="why">
            <span className="eyebrow">Why I built this</span>
            <p className="why-text">
              I kept re-downloading my own Reels and rewriting every caption by
              hand so they'd land right on YouTube. Tedious, every single time.
              So I built Instoob to do it in one click — and made it open source.
              Run it yourself, keep full control: no middleman ever touches your
              videos or your channel tokens.
            </p>
          </section>

          <section className="faq" id="faq">
            <span className="eyebrow">FAQ</span>
            <h3 className="section-title">Questions, answered.</h3>
            <ul className="faq-list">
              {FAQS.map((f, i) => (
                <li
                  key={f.q}
                  className={`faq-item ${openFaq === i ? 'open' : ''}`}
                >
                  <button
                    type="button"
                    className="faq-q"
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                    aria-expanded={openFaq === i}
                  >
                    <span className="faq-num">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="faq-question">{f.q}</span>
                    <span className="faq-toggle">
                      {openFaq === i ? '−' : '+'}
                    </span>
                  </button>
                  {openFaq === i && <p className="faq-a">{f.a}</p>}
                </li>
              ))}
            </ul>
          </section>

          <section className="cta">
            <div className="cta-copy">
              <span className="eyebrow dark">Let's go</span>
              <h3 className="cta-title">
                Join the creators posting everywhere.
              </h3>
              <p className="cta-sub">
                Stop re-downloading and rewriting by hand. Connect your channel
                and turn your next Reel into a Short in one click.
              </p>
              <a className="btn-dark" href={`${API_BASE}/auth/google/login`}>
                Get started ↗
              </a>
            </div>

            <div className="cta-net" aria-hidden="true">
              <svg viewBox="0 0 320 320" className="net-svg">
                <g className="net-lines">
                  <line x1="160" y1="160" x2="280" y2="160" />
                  <line x1="160" y1="160" x2="220" y2="264" />
                  <line x1="160" y1="160" x2="100" y2="264" />
                  <line x1="160" y1="160" x2="40" y2="160" />
                  <line x1="160" y1="160" x2="100" y2="56" />
                  <line x1="160" y1="160" x2="220" y2="56" />
                </g>
              </svg>
              {[
                { img: 12, x: 87.5, y: 50 },
                { img: 32, x: 68.75, y: 82.5 },
                { img: 5, x: 31.25, y: 82.5 },
                { img: 45, x: 12.5, y: 50 },
                { img: 9, x: 31.25, y: 17.5 },
                { img: 68, x: 68.75, y: 17.5 },
              ].map((n) => (
                <img
                  key={n.img}
                  className="net-avatar"
                  src={`https://i.pravatar.cc/96?img=${n.img}`}
                  alt=""
                  style={{ left: `${n.x}%`, top: `${n.y}%` }}
                />
              ))}
              <span className="net-hub">▶</span>
            </div>
          </section>

          <footer className="footer">
            <div className="footer-top">
              <span className="footer-brand">Instoob</span>
              <nav className="footer-nav">
                <a href="#how">How it works</a>
                <a href="#why">Why</a>
                <a href="https://github.com" target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </nav>
            </div>
            <p className="footer-fine">Open source · Self-hosted · MIT</p>
          </footer>
        </div>
      ) : (
        <div className="app">
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
        </div>
      )}
    </main>
  )
}

export default App
