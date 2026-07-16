import { randomUUID } from 'node:crypto'
import type { AddDownloadInput, PendingDownload } from '../shared/downloadTypes'

export type PendingDownloadInput = AddDownloadInput & {
  requestId?: string
  fileSize?: number | null
}

export class PendingDownloadManager {
  private readonly pending = new Map<string, PendingDownload>()
  private readonly requestIds = new Map<string, string>()
  private readonly defaultDirectory: string

  constructor(defaultDirectory: string) {
    this.defaultDirectory = defaultDirectory
  }

  propose(input: PendingDownloadInput): PendingDownload {
    const url = normalizeUrl(input.url)
    if (input.requestId) {
      const existingId = this.requestIds.get(input.requestId)
      const existing = existingId ? this.pending.get(existingId) : undefined
      if (existing) {
        return snapshot(existing)
      }
    }

    const pending: PendingDownload = {
      id: randomUUID(),
      requestId: input.requestId,
      url,
      directory: input.directory || this.defaultDirectory,
      referrer: input.referrer,
      fileName: safeFileName(input.fileName || nameFromUrl(url)),
      fileSize: input.fileSize ?? null,
      headers: input.headers ? { ...input.headers } : undefined,
      createdAt: Date.now()
    }

    this.pending.set(pending.id, pending)
    if (pending.requestId) {
      this.requestIds.set(pending.requestId, pending.id)
    }
    return snapshot(pending)
  }

  list(): PendingDownload[] {
    return [...this.pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(snapshot)
  }

  get(id: string): PendingDownload {
    const pending = this.pending.get(id)
    if (!pending) {
      throw new Error('Pending download not found')
    }
    return snapshot(pending)
  }

  remove(id: string): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    if (pending.requestId) {
      this.requestIds.delete(pending.requestId)
    }
  }
}

function snapshot(pending: PendingDownload): PendingDownload {
  return {
    ...pending,
    headers: pending.headers ? { ...pending.headers } : undefined
  }
}

function normalizeUrl(value: string): string {
  const parsed = new URL(value.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are supported')
  }
  return parsed.toString()
}

function nameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const raw = pathname.split('/').filter(Boolean).pop()
    return raw ? decodeURIComponent(raw) : 'download'
  } catch {
    return 'download'
  }
}

function safeFileName(value: string): string {
  const safe = value
    .split(/[\\/]/)
    .pop()!
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return safe || 'download'
}
