import { useEffect, useState, type FormEvent } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'

type DownloadResponse = {
  video_url: string
  title?: string | null
  uploader?: string | null
  description?: string | null
}

type AuthStatus = {
  authenticated: boolean
  email: string | null
  connected: boolean
  channel_title: string | null
  channel_id: string | null
}

function App() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DownloadResponse | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)

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

  async function onLogout() {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' })
    fetchAuth()
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setResult(null)
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
              {result.description && <pre className="caption">{result.description}</pre>}
            </div>
          )}
        </>
      )}
    </main>
  )
}

export default App
