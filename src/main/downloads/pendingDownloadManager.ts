import { randomUUID } from 'node:crypto'
import type { AddDownloadInput, PendingDownload } from '../../shared/downloadTypes'
import { nameFromUrl, normalizeUrl, safeFileName } from '../../shared/fileNaming'

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
