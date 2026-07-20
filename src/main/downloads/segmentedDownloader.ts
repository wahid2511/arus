import http from 'node:http'
import https from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { open, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import type { DownloadProgressEvent, DownloadSegment } from '../../shared/downloadTypes'
import {
  clampConnections,
  clampMaxSegmentRetries,
  clampMinSegmentSizeBytes
} from '../../shared/fileNaming'
import {
  DynamicSegmentPlanner,
  segmentLength,
  type PlannedSegment
} from './dynamicSegmentPlanner'

export interface SegmentedDownloaderOptions {
  id: string
  url: string
  /** Final destination path (after rename from .part). */
  filePath: string
  tempPath: string
  metaPath: string
  /** Parallel HTTP connections, typically 4–16. */
  connections: number
  /** Minimum remaining bytes before a segment may be split. */
  minSegmentSizeBytes?: number
  /** Extra request headers from the browser companion (Cookie, Referer, …). */
  requestHeaders?: Record<string, string>
  maxRetries?: number
  /** Cap concurrent disk writes to reduce seeking on HDDs. */
  maxConcurrentWrites?: number
  onProgress: (progress: DownloadProgressEvent) => void
}

type ProbeResult = {
  url: string
  supportsRanges: boolean
  totalBytes: number | null
  contentDisposition: string | null
  etag: string | null
  lastModified: string | null
  contentMd5: string | null
}

type MetaFile = {
  version: 2
  url: string
  totalBytes: number
  segments: DownloadSegment[]
  connections: number
  minSegmentSizeBytes: number
  etag: string | null
  lastModified: string | null
  contentMd5: string | null
  contentDisposition: string | null
  mode: 'segmented' | 'single'
}

type AbortReason = 'paused' | 'cancelled' | null

const PROGRESS_INTERVAL_MS = 250
const META_INTERVAL_MS = 400
const META_BYTE_INTERVAL = 256 * 1024
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MIN_SEGMENT_BYTES = 512 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const META_VERSION = 2 as const

const sharedHttpAgent = new HttpAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 })
const sharedHttpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 })

export class RangeSupportLostError extends Error {
  constructor(message = 'Server no longer supports byte ranges') {
    super(message)
    this.name = 'RangeSupportLostError'
  }
}

export function isRangeSupportLostError(error: unknown): error is RangeSupportLostError {
  return (
    error instanceof RangeSupportLostError ||
    (error instanceof Error && error.name === 'RangeSupportLostError')
  )
}

export class SegmentedDownloader {
  private readonly options: Required<
    Pick<
      SegmentedDownloaderOptions,
      'maxRetries' | 'maxConcurrentWrites' | 'minSegmentSizeBytes'
    >
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
  private segments: DownloadSegment[] = []
  private resolvedUrl: string
  private metaChain: Promise<void> = Promise.resolve()
  private planner: DynamicSegmentPlanner | null = null
  private etag: string | null = null
  private lastModified: string | null = null
  private contentMd5: string | null = null
  private contentDisposition: string | null = null
  private bytesSinceMeta = 0
  private metaWriteQueued = false
  private lastMetaWrite = 0
  private rangeFallbackRequested = false

  constructor(options: SegmentedDownloaderOptions) {
    this.options = {
      ...options,
      maxRetries: clampMaxSegmentRetries(options.maxRetries ?? DEFAULT_MAX_RETRIES),
      minSegmentSizeBytes: clampMinSegmentSizeBytes(
        options.minSegmentSizeBytes ?? DEFAULT_MIN_SEGMENT_BYTES
      ),
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
    this.rangeFallbackRequested = false

    try {
      const probe = await this.probe(this.resolvedUrl)
      this.resolvedUrl = probe.url
      this.etag = probe.etag
      this.lastModified = probe.lastModified
      this.contentMd5 = probe.contentMd5
      this.contentDisposition = probe.contentDisposition

      if (probe.supportsRanges && probe.totalBytes && probe.totalBytes > 0) {
        try {
          await this.downloadSegmented(probe.totalBytes)
        } catch (error) {
          if (isRangeSupportLostError(error) || this.rangeFallbackRequested) {
            await this.closeFileHandle().catch(() => undefined)
            await this.resetPartFiles()
            await this.downloadSingle(probe.totalBytes)
          } else {
            throw error
          }
        }
      } else {
        await this.downloadSingle(probe.totalBytes)
      }

      this.throwIfAborted()
      await this.closeFileHandle()
      await this.validateCompletedFile()
      await rename(this.options.tempPath, this.options.filePath)
      await removeQuiet(this.options.metaPath)
      this.emitProgress(true)
    } catch (error) {
      await this.closeFileHandle().catch(() => undefined)
      if (this.abortReason === 'paused') {
        await this.persistMeta(true).catch(() => undefined)
      }
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
      this.planner = new DynamicSegmentPlanner(totalBytes, this.options.minSegmentSizeBytes)
      this.planner.bootstrap()
      this.downloadedBytes = 0
      this.syncSegmentsFromPlanner()
      await this.preallocate(totalBytes)
      await this.persistMeta(true)
    } else {
      this.downloadedBytes = this.planner!.totalDownloaded()
      this.syncSegmentsFromPlanner()
      this.fileHandle = await open(this.options.tempPath, 'r+')
    }

    this.emitProgress(true)
    await this.runWorkerPool()
    this.throwIfAborted()

    if (!this.planner?.allComplete() || !this.planner.coversFullFile()) {
      throw new Error('Download incomplete')
    }
  }

  private async runWorkerPool(): Promise<void> {
    if (!this.planner) {
      throw new Error('Planner is not initialized')
    }

    const workerCount = this.options.connections
    const workers = Array.from({ length: workerCount }, (_, workerId) =>
      this.workerLoop(workerId)
    )
    await Promise.all(workers)
  }

  private async workerLoop(_workerId: number): Promise<void> {
    while (!this.abortReason) {
      if (!this.planner) {
        return
      }

      if (this.planner.allComplete()) {
        return
      }

      const work = this.planner.claimWork()
      if (!work) {
        // Another worker may still be downloading a range too small to split.
        await sleep(25)
        if (this.planner.allComplete() || this.abortReason) {
          return
        }
        // If nothing is active and nothing claimable, we are stuck or done.
        const anyActive = this.planner.getSegments().some((segment) => segment.active)
        if (!anyActive) {
          return
        }
        continue
      }

      try {
        await this.downloadSegmentWithRetry(work)
      } finally {
        this.planner.markActive(work.index, false)
      }
    }
  }

  private async downloadSegmentWithRetry(segment: PlannedSegment): Promise<void> {
    let attempt = 0

    while (true) {
      this.throwIfAborted()

      // Segment may already be complete after a concurrent shrink + finish.
      const current = this.planner?.findByIndex(segment.index)
      if (!current || this.planner!.isComplete(current)) {
        return
      }

      try {
        await this.downloadSegment(current)
        return
      } catch (error) {
        if (this.abortReason) {
          throw error
        }
        if (isRangeSupportLostError(error)) {
          this.rangeFallbackRequested = true
          this.destroyRequests()
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

  private downloadSegment(segment: PlannedSegment): Promise<void> {
    return new Promise((resolve, reject) => {
      const live = this.planner?.findByIndex(segment.index)
      if (!live) {
        resolve()
        return
      }

      const absoluteStart = live.start + live.downloaded
      if (absoluteStart > live.end) {
        resolve()
        return
      }

      const headers: Record<string, string> = {
        Range: `bytes=${absoluteStart}-${live.end}`
      }
      this.applyValidators(headers)

      const request = this.request(this.resolvedUrl, { headers }, (response) => {
        void this.handleSegmentResponse(live, request, response, absoluteStart, 0)
          .then(resolve)
          .catch(reject)
      })

      this.trackRequest(request, reject)
    })
  }

  private async handleSegmentResponse(
    segment: PlannedSegment,
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

    if (response.statusCode === 200) {
      response.resume()
      throw new RangeSupportLostError()
    }

    if (response.statusCode !== 206) {
      response.resume()
      throw new Error(`Server returned HTTP ${response.statusCode}`)
    }

    await this.consumeSegmentBody(segment, response, absoluteStart)
  }

  private consumeSegmentBody(
    segment: PlannedSegment,
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

        const live = this.planner?.findByIndex(segment.index)
        if (!live) {
          response.destroy()
          succeed()
          return
        }

        // Segment end may have been shrunk by a concurrent split — only keep
        // bytes that still belong to this segment.
        const remainingCapacity = live.end - position + 1
        if (remainingCapacity <= 0) {
          response.destroy()
          void this.persistMeta(true)
            .then(() => succeed())
            .catch(fail)
          return
        }

        const usable =
          chunk.length > remainingCapacity ? chunk.subarray(0, remainingCapacity) : chunk
        const reachedBoundary = chunk.length > remainingCapacity

        response.pause()
        void this.enqueueWrite(usable, position)
          .then(() => {
            position += usable.length
            const applied = this.planner?.applyDownloaded(live.index, usable.length) ?? 0
            this.downloadedBytes += applied
            this.bytesSinceMeta += applied
            this.syncSegmentsFromPlanner()
            this.noteProgress()
            void this.persistMetaThrottled()

            if (reachedBoundary || (this.planner && this.planner.isComplete(live))) {
              response.destroy()
              void this.persistMeta(true)
                .then(() => succeed())
                .catch(fail)
              return
            }

            response.resume()
          })
          .catch((error) => {
            response.destroy()
            fail(error instanceof Error ? error : new Error(String(error)))
          })
      })

      response.on('end', () => {
        void this.persistMeta(true)
          .then(() => succeed())
          .catch(fail)
      })

      response.on('error', (error) => {
        if (this.abortReason) {
          fail(new AbortError(this.abortReason))
          return
        }
        // destroy() after a boundary split triggers an error — ignore if settled.
        if (settled) {
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
    this.segments = []
    this.planner = null

    const existing = existsSync(this.options.tempPath)
      ? await open(this.options.tempPath, 'r+')
          .then(async (fh) => {
            const fileStat = await fh.stat()
            await fh.close()
            return fileStat.size
          })
          .catch(() => 0)
      : 0

    this.downloadedBytes = existing
    this.emitProgress(true)

    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (existing > 0) {
        headers.Range = `bytes=${existing}-`
        this.applyValidators(headers)
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

    // Prefer positional writes when total size is known so resume state stays consistent.
    if (this.totalBytes && this.totalBytes > 0) {
      const writeAt = resumeOk ? this.downloadedBytes : 0
      if (resumeOk && writeAt > 0 && existsSync(this.options.tempPath)) {
        this.fileHandle = await open(this.options.tempPath, 'r+')
      } else {
        await this.preallocate(this.totalBytes)
      }
      await this.consumeSinglePositional(response, writeAt)
      return
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

  private consumeSinglePositional(
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
            this.downloadedBytes += chunk.length
            this.noteProgress()
            response.resume()
          })
          .catch((error) => {
            response.destroy()
            fail(error instanceof Error ? error : new Error(String(error)))
          })
      })

      response.on('end', () => succeed())
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

  private async drainWritesAndSync(): Promise<void> {
    await this.writeChain.catch(() => undefined)
    if (this.fileHandle) {
      await this.fileHandle.sync().catch(() => undefined)
    }
  }

  private applyValidators(headers: Record<string, string>): void {
    if (this.etag && !this.etag.startsWith('W/')) {
      headers['If-Range'] = this.etag
    } else if (this.lastModified) {
      headers['If-Range'] = this.lastModified
    }
  }

  private async probe(url: string, redirectCount = 0): Promise<ProbeResult> {
    const head = await this.requestOnce(url, 'HEAD')
    if (isRedirect(head.statusCode) && head.location) {
      if (redirectCount >= 5) {
        return emptyProbe(url)
      }
      return this.probe(new URL(head.location, url).toString(), redirectCount + 1)
    }

    let supportsRanges =
      typeof head.acceptRanges === 'string' && head.acceptRanges.toLowerCase().includes('bytes')
    let totalBytes = head.totalBytes
    let finalUrl = url
    let contentDisposition = head.contentDisposition
    let etag = head.etag
    let lastModified = head.lastModified
    let contentMd5 = head.contentMd5

    // Many CDNs reject or mishandle HEAD — confirm with a 1-byte range GET.
    if (!supportsRanges || !totalBytes) {
      const range = await this.requestOnce(url, 'GET', { Range: 'bytes=0-0' })
      if (isRedirect(range.statusCode) && range.location) {
        if (redirectCount >= 5) {
          return {
            url,
            supportsRanges: false,
            totalBytes,
            contentDisposition,
            etag,
            lastModified,
            contentMd5
          }
        }
        return this.probe(new URL(range.location, url).toString(), redirectCount + 1)
      }

      if (range.statusCode === 206) {
        supportsRanges = true
        totalBytes = range.totalBytes ?? totalBytes
        finalUrl = url
        contentDisposition = range.contentDisposition ?? contentDisposition
        etag = range.etag ?? etag
        lastModified = range.lastModified ?? lastModified
        contentMd5 = range.contentMd5 ?? contentMd5
      } else if (range.statusCode === 200) {
        supportsRanges = false
        totalBytes = range.totalBytes ?? totalBytes
        contentDisposition = range.contentDisposition ?? contentDisposition
        etag = range.etag ?? etag
        lastModified = range.lastModified ?? lastModified
        contentMd5 = range.contentMd5 ?? contentMd5
      }
    }

    return {
      url: finalUrl,
      supportsRanges,
      totalBytes,
      contentDisposition,
      etag,
      lastModified,
      contentMd5
    }
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
    contentDisposition: string | null
    etag: string | null
    lastModified: string | null
    contentMd5: string | null
  }> {
    return new Promise((resolve) => {
      const request = this.request(url, { method, headers }, (response) => {
        response.resume()
        resolve({
          statusCode: response.statusCode || 0,
          location: response.headers.location,
          acceptRanges: response.headers['accept-ranges'],
          totalBytes: totalFromResponse(response, 0),
          contentDisposition: headerString(response.headers['content-disposition']),
          etag: headerString(response.headers.etag),
          lastModified: headerString(response.headers['last-modified']),
          contentMd5: headerString(response.headers['content-md5'])
        })
      })

      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy()
        resolve({
          statusCode: 0,
          totalBytes: null,
          contentDisposition: null,
          etag: null,
          lastModified: null,
          contentMd5: null
        })
      })

      request.on('error', () =>
        resolve({
          statusCode: 0,
          totalBytes: null,
          contentDisposition: null,
          etag: null,
          lastModified: null,
          contentMd5: null
        })
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
        agent: isHttps ? sharedHttpsAgent : sharedHttpAgent,
        timeout: REQUEST_TIMEOUT_MS
      },
      callback
    )
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Request timed out'))
    })
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
    void force
    const total = this.totalBytes
    const percent = total
      ? Math.min(100, Math.round((this.downloadedBytes / total) * 1000) / 10)
      : 0

    this.options.onProgress({
      id: this.options.id,
      downloadedBytes: this.downloadedBytes,
      totalBytes: total,
      speedBytesPerSecond: this.speedBytesPerSecond,
      percent,
      segments:
        this.segments.length > 0 ? this.segments.map((segment) => ({ ...segment })) : undefined
    })
  }

  private syncSegmentsFromPlanner(): void {
    if (this.planner) {
      this.segments = this.planner.snapshot()
    }
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
        meta.version !== META_VERSION ||
        (meta.url !== this.resolvedUrl && meta.url !== this.options.url) ||
        meta.totalBytes !== expectedTotal ||
        !Array.isArray(meta.segments) ||
        meta.segments.length === 0 ||
        meta.mode !== 'segmented'
      ) {
        return false
      }

      // Resource identity changed — restart from scratch.
      if (!validatorsMatch(meta, this.etag, this.lastModified)) {
        await this.resetPartFiles()
        return false
      }

      this.planner = DynamicSegmentPlanner.fromExisting(
        expectedTotal,
        meta.segments,
        meta.minSegmentSizeBytes || this.options.minSegmentSizeBytes
      )

      if (!this.planner.coversFullFile()) {
        this.planner = null
        return false
      }

      this.resolvedUrl = meta.url
      this.etag = meta.etag ?? this.etag
      this.lastModified = meta.lastModified ?? this.lastModified
      this.contentMd5 = meta.contentMd5 ?? this.contentMd5
      this.contentDisposition = meta.contentDisposition ?? this.contentDisposition
      return true
    } catch {
      return false
    }
  }

  private async persistMetaThrottled(): Promise<void> {
    if (this.metaWriteQueued) {
      return
    }

    const dueByBytes = this.bytesSinceMeta >= META_BYTE_INTERVAL
    const delay = dueByBytes ? 0 : Math.max(0, META_INTERVAL_MS - (Date.now() - this.lastMetaWrite))
    this.metaWriteQueued = true
    await sleep(delay)
    this.metaWriteQueued = false
    if (!this.abortReason) {
      await this.persistMeta(false)
    }
  }

  private async persistMeta(forceSync: boolean): Promise<void> {
    if (!this.totalBytes || !this.planner || this.segments.length === 0) {
      return
    }

    const run = async (): Promise<void> => {
      if (forceSync) {
        await this.drainWritesAndSync()
      }

      const payload: MetaFile = {
        version: META_VERSION,
        url: this.resolvedUrl,
        totalBytes: this.totalBytes!,
        connections: this.options.connections,
        minSegmentSizeBytes: this.options.minSegmentSizeBytes,
        segments: this.planner!.snapshot(),
        etag: this.etag,
        lastModified: this.lastModified,
        contentMd5: this.contentMd5,
        contentDisposition: this.contentDisposition,
        mode: 'segmented'
      }

      const tempMeta = `${this.options.metaPath}.tmp`
      await writeFile(tempMeta, JSON.stringify(payload))
      await rename(tempMeta, this.options.metaPath)
      this.lastMetaWrite = Date.now()
      this.bytesSinceMeta = 0
    }

    const next = this.metaChain.then(run, run)
    this.metaChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async validateCompletedFile(): Promise<void> {
    if (!existsSync(this.options.tempPath)) {
      throw new Error('Temporary download file is missing')
    }

    const fileStat = await stat(this.options.tempPath)
    if (this.totalBytes != null && fileStat.size !== this.totalBytes) {
      throw new Error(
        `File size mismatch: expected ${this.totalBytes} bytes, got ${fileStat.size}`
      )
    }

    if (this.contentMd5) {
      const digest = await md5File(this.options.tempPath)
      const expected = normalizeMd5(this.contentMd5)
      if (expected && digest !== expected) {
        throw new Error('Content-MD5 checksum mismatch')
      }
    }
  }

  private async resetPartFiles(): Promise<void> {
    await this.closeFileHandle().catch(() => undefined)
    await removeQuiet(this.options.tempPath)
    await removeQuiet(this.options.metaPath)
    this.segments = []
    this.planner = null
    this.downloadedBytes = 0
  }

  private async closeFileHandle(): Promise<void> {
    if (!this.fileHandle) {
      return
    }

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

function emptyProbe(url: string): ProbeResult {
  return {
    url,
    supportsRanges: false,
    totalBytes: null,
    contentDisposition: null,
    etag: null,
    lastModified: null,
    contentMd5: null
  }
}

function validatorsMatch(
  meta: Pick<MetaFile, 'etag' | 'lastModified'>,
  etag: string | null,
  lastModified: string | null
): boolean {
  if (meta.etag && etag) {
    return meta.etag === etag
  }
  if (meta.lastModified && lastModified) {
    return meta.lastModified === lastModified
  }
  // No validators available on either side — allow resume by size/url alone.
  return true
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null
  }
  return typeof value === 'string' ? value : null
}

function isRedirect(statusCode: number | undefined): boolean {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  )
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

function normalizeMd5(value: string): string | null {
  const trimmed = value.trim().replace(/^"|"$/g, '')
  // Base64 Content-MD5 → hex
  if (/^[A-Za-z0-9+/]+=*$/.test(trimmed) && trimmed.length !== 32) {
    try {
      return Buffer.from(trimmed, 'base64').toString('hex')
    } catch {
      return null
    }
  }
  if (/^[a-fA-F0-9]{32}$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  return null
}

async function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
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

// Re-export for tests that inspect segment math alongside the downloader.
export { segmentLength }
