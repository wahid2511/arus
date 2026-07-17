import http from 'node:http'
import https from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { createWriteStream } from 'node:fs'
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { DownloadProgressEvent, DownloadSegment } from '../../shared/downloadTypes'
import { clampConnections } from '../../shared/fileNaming'

type SegmentState = DownloadSegment

export interface SegmentedDownloaderOptions {
  id: string
  url: string
  /** Final destination path (after rename from .part). */
  filePath: string
  tempPath: string
  metaPath: string
  /** Parallel HTTP connections, typically 4–16. */
  connections: number
  /** Extra request headers from the browser companion (Cookie, Referer, …). */
  requestHeaders?: Record<string, string>
  maxRetries?: number
  /** Cap concurrent disk writes to reduce seeking on HDDs. */
  maxConcurrentWrites?: number
  onProgress: (progress: DownloadProgressEvent) => void
}

type MetaFile = {
  url: string
  totalBytes: number
  segments: SegmentState[]
  connections: number
}

type AbortReason = 'paused' | 'cancelled' | null

const PROGRESS_INTERVAL_MS = 250
const DEFAULT_MAX_RETRIES = 3
const MIN_SEGMENT_BYTES = 256 * 1024

const sharedHttpAgent = new HttpAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 })
const sharedHttpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 })

export class SegmentedDownloader {
  private readonly options: Required<
    Pick<SegmentedDownloaderOptions, 'maxRetries' | 'maxConcurrentWrites'>
  > &
    SegmentedDownloaderOptions

  private abortReason: AbortReason = null
  private activeRequests = new Set<ClientRequest>()
  private fileHandle: FileHandle | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private lastProgressAt = 0
  private lastProgressBytes = 0
  private speedBytesPerSecond = 0
  private downloadedBytes = 0
  private totalBytes: number | null = null
  private segments: SegmentState[] = []
  private resolvedUrl: string
  private metaChain: Promise<void> = Promise.resolve()

  constructor(options: SegmentedDownloaderOptions) {
    this.options = {
      maxRetries: DEFAULT_MAX_RETRIES,
      ...options,
      connections: clampConnections(options.connections),
      // FileHandle is not safe for concurrent writes — keep disk I/O serial while
      // HTTP segments stay parallel (each segment back-pressures on its write).
      maxConcurrentWrites: 1
    }
    this.resolvedUrl = options.url
  }

  async start(): Promise<void> {
    this.abortReason = null
    this.lastProgressAt = Date.now()
    this.lastProgressBytes = 0
    this.speedBytesPerSecond = 0

    try {
      const probe = await this.probe(this.resolvedUrl)
      this.resolvedUrl = probe.url

      if (probe.supportsRanges && probe.totalBytes && probe.totalBytes > 0) {
        await this.downloadSegmented(probe.totalBytes)
      } else {
        await this.downloadSingle(probe.totalBytes)
      }

      this.throwIfAborted()

      await this.closeFileHandle()
      await rename(this.options.tempPath, this.options.filePath)
      await removeQuiet(this.options.metaPath)
      this.emitProgress(true)
    } catch (error) {
      await this.closeFileHandle().catch(() => undefined)
      throw error
    }
  }

  pause(): void {
    this.abortReason = 'paused'
    this.destroyRequests()
  }

  cancel(): void {
    this.abortReason = 'cancelled'
    this.destroyRequests()
  }

  private async downloadSegmented(totalBytes: number): Promise<void> {
    this.totalBytes = totalBytes
    const resumed = await this.loadMeta(totalBytes)

    if (!resumed) {
      this.segments = buildSegments(totalBytes, this.options.connections)
      this.downloadedBytes = 0
      await this.preallocate(totalBytes)
      await this.persistMeta()
    } else {
      this.downloadedBytes = this.segments.reduce((sum, segment) => sum + segment.downloaded, 0)
      this.fileHandle = await open(this.options.tempPath, 'r+')
    }

    this.emitProgress(true)

    const pending = this.segments.filter((segment) => segment.downloaded < segmentLength(segment))
    await Promise.all(pending.map((segment) => this.downloadSegmentWithRetry(segment)))

    this.throwIfAborted()

    const complete = this.segments.every((segment) => segment.downloaded >= segmentLength(segment))
    if (!complete) {
      throw new Error('Download incomplete')
    }
  }

  private async downloadSegmentWithRetry(segment: SegmentState): Promise<void> {
    let attempt = 0

    while (true) {
      this.throwIfAborted()

      try {
        await this.downloadSegment(segment)
        return
      } catch (error) {
        if (this.abortReason) {
          throw error
        }

        attempt += 1
        if (attempt > this.options.maxRetries) {
          throw error instanceof Error ? error : new Error(String(error))
        }

        const delayMs = Math.min(8_000, 300 * 2 ** (attempt - 1))
        await sleep(delayMs)
      }
    }
  }

  private downloadSegment(segment: SegmentState): Promise<void> {
    return new Promise((resolve, reject) => {
      const absoluteStart = segment.start + segment.downloaded
      if (absoluteStart > segment.end) {
        resolve()
        return
      }

      const headers: Record<string, string> = {
        Range: `bytes=${absoluteStart}-${segment.end}`
      }

      const request = this.request(this.resolvedUrl, { headers }, (response) => {
        void this.handleSegmentResponse(segment, request, response, absoluteStart, 0)
          .then(resolve)
          .catch(reject)
      })

      this.trackRequest(request, reject)
    })
  }

  private async handleSegmentResponse(
    segment: SegmentState,
    request: ClientRequest,
    response: IncomingMessage,
    absoluteStart: number,
    redirectCount: number
  ): Promise<void> {
    const location = response.headers.location
    if (isRedirect(response.statusCode) && location) {
      request.destroy()
      if (redirectCount >= 5) {
        throw new Error('Too many redirects')
      }

      this.resolvedUrl = new URL(location, this.resolvedUrl).toString()
      await this.downloadSegment(segment)
      return
    }

    if (response.statusCode !== 206) {
      response.resume()
      throw new Error(
        response.statusCode === 200
          ? 'Server does not honor byte ranges'
          : `Server returned HTTP ${response.statusCode}`
      )
    }

    await this.consumeSegmentBody(segment, response, absoluteStart)
  }

  private consumeSegmentBody(
    segment: SegmentState,
    response: IncomingMessage,
    writePosition: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let position = writePosition
      let settled = false

      const fail = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        reject(error)
      }

      const succeed = (): void => {
        if (settled) {
          return
        }
        settled = true
        resolve()
      }

      response.on('data', (chunk: Buffer) => {
        if (this.abortReason) {
          response.destroy()
          fail(new AbortError(this.abortReason))
          return
        }

        response.pause()
        void this.enqueueWrite(chunk, position)
          .then(() => {
            position += chunk.length
            segment.downloaded += chunk.length
            this.downloadedBytes += chunk.length
            this.noteProgress()
            void this.persistMetaThrottled()
            response.resume()
          })
          .catch((error) => {
            response.destroy()
            fail(error instanceof Error ? error : new Error(String(error)))
          })
      })

      response.on('end', () => {
        void this.persistMeta()
          .then(() => succeed())
          .catch(fail)
      })

      response.on('error', (error) => {
        if (this.abortReason) {
          fail(new AbortError(this.abortReason))
          return
        }
        fail(error)
      })

      response.on('close', () => {
        if (!settled && this.abortReason) {
          fail(new AbortError(this.abortReason))
        }
      })
    })
  }

  private async downloadSingle(knownTotal: number | null): Promise<void> {
    this.totalBytes = knownTotal
    const existing = existsSync(this.options.tempPath)
      ? (await open(this.options.tempPath, 'r+').then(async (fh) => {
          const stat = await fh.stat()
          await fh.close()
          return stat.size
        }).catch(() => 0))
      : 0

    this.downloadedBytes = existing
    this.emitProgress(true)

    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (existing > 0) {
        headers.Range = `bytes=${existing}-`
      }

      const request = this.request(this.resolvedUrl, { headers }, (response) => {
        void this.handleSingleResponse(request, response, existing, 0).then(resolve).catch(reject)
      })

      this.trackRequest(request, reject)
    })
  }

  private async handleSingleResponse(
    request: ClientRequest,
    response: IncomingMessage,
    startAt: number,
    redirectCount: number
  ): Promise<void> {
    const location = response.headers.location
    if (isRedirect(response.statusCode) && location) {
      request.destroy()
      if (redirectCount >= 5) {
        throw new Error('Too many redirects')
      }

      this.resolvedUrl = new URL(location, this.resolvedUrl).toString()
      await this.downloadSingle(this.totalBytes)
      return
    }

    if (response.statusCode !== 200 && response.statusCode !== 206) {
      response.resume()
      throw new Error(`Server returned HTTP ${response.statusCode}`)
    }

    const resumeOk = response.statusCode === 206
    if (startAt > 0 && !resumeOk) {
      await removeQuiet(this.options.tempPath)
      this.downloadedBytes = 0
    }

    const total = totalFromResponse(response, resumeOk ? this.downloadedBytes : 0)
    if (total) {
      this.totalBytes = total
    }

    const flags = resumeOk && this.downloadedBytes > 0 ? 'a' : 'w'
    const stream = createWriteStream(this.options.tempPath, { flags })

    await new Promise<void>((resolve, reject) => {
      response.on('data', (chunk: Buffer) => {
        if (this.abortReason) {
          response.destroy()
          stream.destroy()
          return
        }

        this.downloadedBytes += chunk.length
        this.noteProgress()

        if (!stream.write(chunk)) {
          response.pause()
          stream.once('drain', () => response.resume())
        }
      })

      response.on('end', () => {
        stream.end(() => resolve())
      })

      response.on('error', reject)
      stream.on('error', reject)
    })
  }

  private async preallocate(totalBytes: number): Promise<void> {
    // 'w+' creates/truncates then we size the file — avoids Windows EPERM from append+ftruncate.
    const handle = await open(this.options.tempPath, 'w+')
    try {
      await handle.truncate(totalBytes)
    } catch {
      // Fallback when sparse truncate is unavailable: punch a single byte at EOF-1.
      const marker = Buffer.alloc(1)
      await handle.write(marker, 0, 1, totalBytes - 1)
    }
    this.fileHandle = handle
  }

  private enqueueWrite(chunk: Buffer, position: number): Promise<void> {
    const run = async (): Promise<void> => {
      if (!this.fileHandle) {
        throw new Error('File handle is not open')
      }
      await this.fileHandle.write(chunk, 0, chunk.length, position)
    }

    const next = this.writeChain.then(run, run)
    this.writeChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async probe(
    url: string,
    redirectCount = 0
  ): Promise<{ url: string; supportsRanges: boolean; totalBytes: number | null }> {
    const head = await this.requestOnce(url, 'HEAD')
    if (isRedirect(head.statusCode) && head.location) {
      if (redirectCount >= 5) {
        return { url, supportsRanges: false, totalBytes: null }
      }
      return this.probe(new URL(head.location, url).toString(), redirectCount + 1)
    }

    let supportsRanges =
      typeof head.acceptRanges === 'string' && head.acceptRanges.includes('bytes')
    let totalBytes = head.totalBytes
    let finalUrl = url

    // Many CDNs reject or mishandle HEAD — confirm with a 1-byte range GET.
    if (!supportsRanges || !totalBytes) {
      const range = await this.requestOnce(url, 'GET', { Range: 'bytes=0-0' })
      if (isRedirect(range.statusCode) && range.location) {
        if (redirectCount >= 5) {
          return { url, supportsRanges: false, totalBytes: totalBytes }
        }
        return this.probe(new URL(range.location, url).toString(), redirectCount + 1)
      }

      if (range.statusCode === 206) {
        supportsRanges = true
        totalBytes = range.totalBytes ?? totalBytes
        finalUrl = url
      } else if (range.statusCode === 200 && range.totalBytes) {
        totalBytes = range.totalBytes
      }
    }

    return { url: finalUrl, supportsRanges, totalBytes }
  }

  private requestOnce(
    url: string,
    method: 'HEAD' | 'GET',
    headers: Record<string, string> = {}
  ): Promise<{
    statusCode: number
    location?: string
    acceptRanges?: string | string[]
    totalBytes: number | null
  }> {
    return new Promise((resolve) => {
      const request = this.request(url, { method, headers }, (response) => {
        response.resume()
        resolve({
          statusCode: response.statusCode || 0,
          location: response.headers.location,
          acceptRanges: response.headers['accept-ranges'],
          totalBytes: totalFromResponse(response, 0)
        })
      })

      request.on('error', () =>
        resolve({ statusCode: 0, totalBytes: null })
      )
    })
  }

  private request(
    url: string,
    options: { method?: string; headers?: Record<string, string> },
    callback: (response: IncomingMessage) => void
  ): ClientRequest {
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const client = isHttps ? https : http
    const request = client.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          ...(this.options.requestHeaders || {}),
          ...(options.headers || {})
        },
        agent: isHttps ? sharedHttpsAgent : sharedHttpAgent
      },
      callback
    )
    request.end()
    return request
  }

  private trackRequest(request: ClientRequest, reject: (error: Error) => void): void {
    this.activeRequests.add(request)
    request.on('close', () => this.activeRequests.delete(request))
    request.on('error', (error) => {
      this.activeRequests.delete(request)
      if (this.abortReason) {
        reject(new AbortError(this.abortReason))
        return
      }
      reject(error)
    })
  }

  private destroyRequests(): void {
    for (const request of this.activeRequests) {
      request.destroy()
    }
    this.activeRequests.clear()
  }

  private noteProgress(): void {
    const now = Date.now()
    const elapsed = now - this.lastProgressAt
    if (elapsed < PROGRESS_INTERVAL_MS) {
      return
    }

    const delta = this.downloadedBytes - this.lastProgressBytes
    this.speedBytesPerSecond = Math.max(0, Math.round((delta * 1000) / elapsed))
    this.lastProgressAt = now
    this.lastProgressBytes = this.downloadedBytes
    this.emitProgress(false)
  }

  private emitProgress(force: boolean): void {
    if (!force) {
      // noteProgress already gated by interval
    }

    const total = this.totalBytes
    const percent = total ? Math.min(100, Math.round((this.downloadedBytes / total) * 1000) / 10) : 0

    this.options.onProgress({
      id: this.options.id,
      downloadedBytes: this.downloadedBytes,
      totalBytes: total,
      speedBytesPerSecond: this.speedBytesPerSecond,
      percent,
      segments: this.segments.length > 0 ? this.segments.map((segment) => ({ ...segment })) : undefined
    })
  }

  private async loadMeta(expectedTotal: number): Promise<boolean> {
    if (!existsSync(this.options.metaPath) || !existsSync(this.options.tempPath)) {
      return false
    }

    try {
      const raw = await readFile(this.options.metaPath, 'utf8')
      const meta = JSON.parse(raw) as MetaFile
      if (
        !meta ||
        (meta.url !== this.resolvedUrl && meta.url !== this.options.url) ||
        meta.totalBytes !== expectedTotal ||
        !Array.isArray(meta.segments) ||
        meta.segments.length === 0
      ) {
        return false
      }

      this.segments = meta.segments.map((segment) => ({ ...segment }))
      this.resolvedUrl = meta.url
      return true
    } catch {
      return false
    }
  }

  private metaWriteQueued = false
  private lastMetaWrite = 0

  private async persistMetaThrottled(): Promise<void> {
    if (this.metaWriteQueued) {
      return
    }

    const delay = Math.max(0, 400 - (Date.now() - this.lastMetaWrite))
    this.metaWriteQueued = true
    await sleep(delay)
    this.metaWriteQueued = false
    if (!this.abortReason) {
      await this.persistMeta()
    }
  }

  private async persistMeta(): Promise<void> {
    if (!this.totalBytes || this.segments.length === 0) {
      return
    }

    const run = async (): Promise<void> => {
      const payload: MetaFile = {
        url: this.resolvedUrl,
        totalBytes: this.totalBytes!,
        connections: this.options.connections,
        segments: this.segments.map((segment) => ({ ...segment }))
      }

      await writeFile(this.options.metaPath, JSON.stringify(payload))
      this.lastMetaWrite = Date.now()
    }

    const next = this.metaChain.then(run, run)
    this.metaChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async closeFileHandle(): Promise<void> {
    if (!this.fileHandle) {
      return
    }

    // Drain pending writes first.
    await this.writeChain.catch(() => undefined)
    await this.fileHandle.close()
    this.fileHandle = null
  }

  private throwIfAborted(): void {
    if (this.abortReason) {
      throw new AbortError(this.abortReason)
    }
  }
}

export class AbortError extends Error {
  readonly reason: 'paused' | 'cancelled'

  constructor(reason: 'paused' | 'cancelled') {
    super(reason === 'paused' ? 'Download paused' : 'Download cancelled')
    this.name = 'AbortError'
    this.reason = reason
  }
}

export function isAbortError(error: unknown): error is AbortError {
  return error instanceof AbortError || (error instanceof Error && error.name === 'AbortError')
}

function buildSegments(totalBytes: number, connections: number): SegmentState[] {
  const maxBySize = Math.max(1, Math.floor(totalBytes / MIN_SEGMENT_BYTES))
  const count = Math.min(connections, maxBySize, 16)
  const segmentSize = Math.ceil(totalBytes / count)

  return Array.from({ length: count }, (_, index) => {
    const start = index * segmentSize
    const end = Math.min(totalBytes - 1, start + segmentSize - 1)
    return { index, start, end, downloaded: 0 }
  })
}

function segmentLength(segment: SegmentState): number {
  return segment.end - segment.start + 1
}

function isRedirect(statusCode: number | undefined): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308
}

function totalFromResponse(response: IncomingMessage, offset: number): number | null {
  const contentRange = response.headers['content-range']
  if (typeof contentRange === 'string') {
    const match = /\/(\d+)$/.exec(contentRange)
    if (match) {
      return Number(match[1])
    }
  }

  const length = Number(response.headers['content-length'])
  if (Number.isFinite(length) && length > 0) {
    return length + offset
  }

  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function removeQuiet(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // ignore
  }
}
