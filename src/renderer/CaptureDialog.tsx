import { useEffect, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import type { PendingDownload } from '../shared/downloadTypes'
import { formatBytes } from './utils/format'

export default function CaptureDialog(): ReactElement {
  const [pending, setPending] = useState<PendingDownload | null>(null)
  const [fileName, setFileName] = useState('')
  const [directory, setDirectory] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.downloads.listPending().then((items) => setPending(items[0] || null))
    return window.downloads.onPending(setPending)
  }, [])

  useEffect(() => {
    if (!pending) {
      return
    }
    setFileName(pending.fileName)
    setDirectory(pending.directory)
    setMessage('')
    setBusy(false)
  }, [pending])

  async function chooseDirectory(): Promise<void> {
    const chosen = await window.downloads.chooseDirectory()
    if (chosen) {
      setDirectory(chosen)
    }
  }

  async function reject(): Promise<void> {
    if (!pending || busy) {
      return
    }
    setBusy(true)
    try {
      await window.downloads.rejectPending(pending.id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Gagal membatalkan unduhan')
      setBusy(false)
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!pending || busy) {
      return
    }
    setBusy(true)
    setMessage('')
    try {
      await window.downloads.confirmPending({
        id: pending.id,
        fileName,
        directory
      })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Gagal memulai unduhan')
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        void reject()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (!pending) {
    return <div className="capture-shell" />
  }

  return (
    <div className="capture-shell">
      <header className="capture-titlebar">
        <div>
          <p className="capture-eyebrow">Terdeteksi dari browser</p>
          <h1>Konfirmasi unduhan</h1>
        </div>
        <button type="button" className="capture-close" onClick={() => void reject()} aria-label="Batal">
          ×
        </button>
      </header>

      <form className="capture-form" onSubmit={(event) => void confirm(event)}>
        <div className="capture-source">
          <span className="capture-source__name">{pending.fileName}</span>
          <span className="capture-source__meta">
            {pending.fileSize && pending.fileSize > 0 ? formatBytes(pending.fileSize) : 'Ukuran belum diketahui'}
          </span>
          <span className="capture-source__url" title={pending.url}>
            {pending.url}
          </span>
        </div>

        <label>
          Nama file
          <input
            autoFocus
            required
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
          />
        </label>

        <label>
          Simpan ke
          <div className="folder-row">
            <input
              required
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
            />
            <button type="button" className="btn-ghost" onClick={() => void chooseDirectory()}>
              Pilih
            </button>
          </div>
        </label>

        {message ? <p className="dialog__error">{message}</p> : null}

        <div className="dialog__actions">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void reject()}>
            Batal
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Memproses…' : 'Mulai download'}
          </button>
        </div>
      </form>
    </div>
  )
}
