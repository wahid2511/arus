import https from 'node:https'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type {
  NetworkEndpointInfo,
  SpeedTestProgress,
  SpeedTestResult
} from '../../shared/downloadTypes'

const SERVER = 'Cloudflare'
const BASE_HOST = 'speed.cloudflare.com'
const LATENCY_SAMPLES = 12
const PARALLEL_STREAMS = 6
const WARMUP_MS = 2_000
const MEASURE_MS = 8_000
const SAMPLE_INTERVAL_MS = 100
const SLIDING_WINDOW_MS = 1_000
/** Bytes requested per stream round — large enough to keep sockets saturated. */
const DOWNLOAD_ROUND_BYTES = 25 * 1024 * 1024
const UPLOAD_ROUND_BYTES = 12 * 1024 * 1024
const UPLOAD_WRITE_CHUNK = 256 * 1024

type ProgressHandler = (progress: SpeedTestProgress) => void

interface NetworkContext {
  localIp: string | null
  publicIp: string | null
  interfaceName: string | null
  colo: string | null
}

export class SpeedTestService {
  private readonly activeRequests = new Set<ClientRequest>()
  private cancelled = false
  private running = false
  private agent: https.Agent | null = null
  private readonly onProgress: ProgressHandler

  constructor(onProgress: ProgressHandler) {
    this.onProgress = onProgress
  }

  async getNetworkInfo(): Promise<NetworkEndpointInfo> {
    const local = resolveLocalEndpoint()
    const remote = await fetchCloudflareTrace().catch(() => ({
      publicIp: null as string | null,
      colo: null as string | null
    }))
    return {
      localIp: local.localIp,
      publicIp: remote.publicIp,
      interfaceName: local.interfaceName,
      colo: remote.colo,
      location: remote.colo ? `Cloudflare ${remote.colo}` : null
    }
  }

  async start(): Promise<SpeedTestResult> {
    if (this.running) {
      throw new Error('Speed test sedang berjalan')
    }

    this.running = true
    this.cancelled = false
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: PARALLEL_STREAMS + 2,
      maxFreeSockets: PARALLEL_STREAMS,
      timeout: 60_000
    })

    const network: NetworkContext = {
      localIp: null,
      publicIp: null,
      interfaceName: null,
      colo: null
    }

    try {
      this.emit({
        phase: 'latency',
        progress: 0.04,
        message: 'Mendeteksi jaringan...',
        server: SERVER,
        ...network
      })

      const resolved = await this.getNetworkInfo()
      network.localIp = resolved.localIp
      network.publicIp = resolved.publicIp
      network.interfaceName = resolved.interfaceName ?? null
      network.colo = resolved.colo ?? null

      const serverLabel = network.colo ? `${SERVER} (${network.colo})` : SERVER

      this.emit({
        phase: 'latency',
        progress: 0.08,
        message: 'Mengukur latency...',
        server: serverLabel,
        ...network
      })
      const latencyMs = await this.measureLatency(serverLabel, network)

      this.assertNotCancelled()
      this.emit({
        phase: 'download',
        progress: 0.28,
        message: 'Mengukur download (multi-stream)...',
        latencyMs,
        server: serverLabel,
        ...network
      })
      const downloadMbps = await this.measureThroughput('download', latencyMs, undefined, serverLabel, network)

      this.assertNotCancelled()
      this.emit({
        phase: 'upload',
        progress: 0.68,
        message: 'Mengukur upload (multi-stream)...',
        latencyMs,
        downloadMbps,
        server: serverLabel,
        ...network
      })
      const uploadMbps = await this.measureThroughput(
        'upload',
        latencyMs,
        downloadMbps,
        serverLabel,
        network
      )

      const result: SpeedTestResult = {
        latencyMs,
        downloadMbps,
        uploadMbps,
        server: serverLabel,
        localIp: network.localIp,
        publicIp: network.publicIp,
        interfaceName: network.interfaceName,
        colo: network.colo,
        finishedAt: Date.now()
      }
      this.emit({
        phase: 'complete',
        progress: 1,
        message: 'Speed test selesai',
        latencyMs,
        downloadMbps,
        uploadMbps,
        server: serverLabel,
        ...network
      })
      return result
    } catch (error) {
      if (this.cancelled) {
        this.emit({
          phase: 'cancelled',
          progress: 0,
          message: 'Speed test dibatalkan',
          server: SERVER,
          ...network
        })
        throw new Error('Speed test dibatalkan')
      }

      const message = error instanceof Error ? error.message : 'Speed test gagal'
      this.emit({
        phase: 'error',
        progress: 0,
        message,
        error: message,
        server: SERVER,
        ...network
      })
      throw error
    } finally {
      this.running = false
      this.cancelled = false
      this.destroyActiveRequests()
      this.agent?.destroy()
      this.agent = null
    }
  }

  cancel(): void {
    this.cancelled = true
    this.destroyActiveRequests()
  }

  private async measureLatency(server: string, network: NetworkContext): Promise<number> {
    // Warm the TLS/TCP path so samples reflect RTT, not handshake.
    await this.requestDownload(0)
    this.assertNotCancelled()

    const samples: number[] = []
    for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
      this.assertNotCancelled()
      const startedAt = performance.now()
      await this.requestDownload(0)
      samples.push(performance.now() - startedAt)
      this.emit({
        phase: 'latency',
        progress: 0.08 + ((index + 1) / LATENCY_SAMPLES) * 0.18,
        message: `Mengukur latency (${index + 1}/${LATENCY_SAMPLES})`,
        latencyMs: Math.round(trimmedMean(samples)),
        server,
        ...network
      })
    }

    return Math.round(trimmedMean(samples))
  }

  private async measureThroughput(
    kind: 'download' | 'upload',
    latencyMs: number,
    downloadMbps: number | undefined,
    server: string,
    network: NetworkContext
  ): Promise<number> {
    const sampler = new ThroughputSampler()
    const startedAt = performance.now()
    const warmupEndsAt = startedAt + WARMUP_MS
    const endsAt = warmupEndsAt + MEASURE_MS
    let stopWorkers = false
    let lastEmitAt = 0

    const emitLive = (): void => {
      const now = performance.now()
      if (now - lastEmitAt < 120) {
        return
      }
      lastEmitAt = now
      const elapsed = now - startedAt
      const phaseProgress =
        kind === 'download'
          ? 0.28 + Math.min(1, elapsed / (WARMUP_MS + MEASURE_MS)) * 0.35
          : 0.68 + Math.min(1, elapsed / (WARMUP_MS + MEASURE_MS)) * 0.28
      const inWarmup = now < warmupEndsAt
      this.emit({
        phase: kind,
        progress: phaseProgress,
        message: inWarmup
          ? `Pemanasan ${kind}...`
          : `Mengukur ${kind} (steady-state)...`,
        latencyMs,
        downloadMbps,
        currentMbps: sampler.liveMbps(warmupEndsAt, now),
        server,
        ...network
      })
    }

    const workers = Array.from({ length: PARALLEL_STREAMS }, async () => {
      while (!stopWorkers && !this.cancelled && performance.now() < endsAt) {
        try {
          if (kind === 'download') {
            await this.requestDownload(DOWNLOAD_ROUND_BYTES, (delta) => {
              sampler.add(delta, performance.now())
              emitLive()
            })
          } else {
            await this.requestUpload(UPLOAD_ROUND_BYTES, (delta) => {
              sampler.add(delta, performance.now())
              emitLive()
            })
          }
        } catch {
          if (stopWorkers || this.cancelled) {
            return
          }
        }
      }
    })

    await sleep(WARMUP_MS + MEASURE_MS)
    stopWorkers = true
    this.destroyActiveRequests()
    await Promise.allSettled(workers)
    this.assertNotCancelled()

    const finishedAt = performance.now()
    const mbps = sampler.preciseMbps(warmupEndsAt, finishedAt)
    if (!Number.isFinite(mbps) || mbps <= 0) {
      throw new Error(`Gagal mengukur ${kind}`)
    }
    return roundMbps(mbps)
  }

  private requestDownload(bytes: number, onDelta?: (delta: number) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = https.get(
        {
          hostname: BASE_HOST,
          path: `/__down?bytes=${bytes}`,
          agent: this.agent ?? undefined,
          headers: {
            'cache-control': 'no-store',
            pragma: 'no-cache'
          }
        },
        (response) => {
          let received = 0
          response.on('data', (chunk: Buffer) => {
            const delta = chunk.length
            received += delta
            onDelta?.(delta)
          })
          response.on('end', () => {
            this.activeRequests.delete(request)
            if (isOk(response)) {
              resolve(received)
            } else {
              reject(new Error(`Server speed test merespons ${response.statusCode}`))
            }
          })
        }
      )

      this.bindRequest(request, reject)
    })
  }

  private requestUpload(bytes: number, onDelta?: (delta: number) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          hostname: BASE_HOST,
          path: '/__up',
          method: 'POST',
          agent: this.agent ?? undefined,
          headers: {
            'content-length': String(bytes),
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store'
          }
        },
        (response) => {
          response.resume()
          response.on('end', () => {
            this.activeRequests.delete(request)
            if (isOk(response)) {
              resolve(bytes)
            } else {
              reject(new Error(`Server speed test merespons ${response.statusCode}`))
            }
          })
        }
      )

      this.bindRequest(request, reject)

      const chunk = Buffer.alloc(UPLOAD_WRITE_CHUNK)
      let sent = 0
      const writeNext = (): void => {
        if (this.cancelled) {
          request.destroy(new Error('Speed test dibatalkan'))
          return
        }
        while (sent < bytes) {
          const nextSize = Math.min(UPLOAD_WRITE_CHUNK, bytes - sent)
          const payload = nextSize === UPLOAD_WRITE_CHUNK ? chunk : chunk.subarray(0, nextSize)
          const canContinue = request.write(payload)
          sent += nextSize
          onDelta?.(nextSize)
          if (!canContinue) {
            request.once('drain', writeNext)
            return
          }
        }
        request.end()
      }

      writeNext()
    })
  }

  private bindRequest(request: ClientRequest, reject: (error: Error) => void): void {
    this.activeRequests.add(request)
    request.setTimeout(45_000, () => request.destroy(new Error('Speed test timeout')))
    request.on('error', (error) => {
      this.activeRequests.delete(request)
      if (this.cancelled) {
        reject(new Error('Speed test dibatalkan'))
        return
      }
      reject(error)
    })
  }

  private destroyActiveRequests(): void {
    for (const request of this.activeRequests) {
      request.destroy(new Error('Speed test dibatalkan'))
    }
    this.activeRequests.clear()
  }

  private emit(progress: SpeedTestProgress): void {
    this.onProgress(progress)
  }

  private assertNotCancelled(): void {
    if (this.cancelled) {
      throw new Error('Speed test dibatalkan')
    }
  }
}

/** Tracks aggregate bytes and derives Ookla-like precise Mbps from sliding windows. */
class ThroughputSampler {
  private readonly points: Array<{ t: number; bytes: number }> = []
  private totalBytes = 0

  add(delta: number, now: number): void {
    this.totalBytes += delta
    const last = this.points[this.points.length - 1]
    if (last && now - last.t < SAMPLE_INTERVAL_MS / 2) {
      last.bytes = this.totalBytes
      last.t = now
      return
    }
    this.points.push({ t: now, bytes: this.totalBytes })
  }

  liveMbps(warmupEndsAt: number, now: number): number {
    if (now <= warmupEndsAt) {
      const elapsed = Math.max(0.2, (now - (warmupEndsAt - WARMUP_MS)) / 1000)
      return roundMbps(bytesToMbps(this.totalBytes, elapsed))
    }
    return roundMbps(this.preciseMbps(warmupEndsAt, now) || this.steadyMbps(warmupEndsAt, now))
  }

  preciseMbps(warmupEndsAt: number, now: number): number {
    const windows = this.slidingWindowsMbps(warmupEndsAt)
    if (windows.length === 0) {
      return this.steadyMbps(warmupEndsAt, now)
    }
    // Average of the top 30% of 1s windows (Ookla-style), not a single spike.
    const sorted = [...windows].sort((a, b) => b - a)
    const keep = Math.max(1, Math.ceil(sorted.length * 0.3))
    const top = sorted.slice(0, keep)
    return top.reduce((sum, value) => sum + value, 0) / top.length
  }

  private steadyMbps(warmupEndsAt: number, now: number): number {
    const startBytes = this.bytesAt(warmupEndsAt)
    const elapsed = Math.max(0.2, (now - warmupEndsAt) / 1000)
    return bytesToMbps(Math.max(0, this.totalBytes - startBytes), elapsed)
  }

  private slidingWindowsMbps(warmupEndsAt: number): number[] {
    const relevant = this.points.filter((point) => point.t >= warmupEndsAt - SLIDING_WINDOW_MS)
    if (relevant.length < 2) {
      return []
    }

    const values: number[] = []
    let left = 0
    for (let right = 0; right < relevant.length; right += 1) {
      const end = relevant[right]
      if (end.t < warmupEndsAt) {
        continue
      }
      while (left < right && end.t - relevant[left].t > SLIDING_WINDOW_MS) {
        left += 1
      }
      const start = relevant[Math.max(0, left - 1)]
      const dt = (end.t - start.t) / 1000
      if (dt >= 0.75) {
        values.push(bytesToMbps(end.bytes - start.bytes, dt))
      }
    }
    return values
  }

  private bytesAt(targetTime: number): number {
    if (this.points.length === 0) {
      return 0
    }
    let best = this.points[0]
    for (const point of this.points) {
      if (point.t <= targetTime) {
        best = point
      } else {
        break
      }
    }
    return best.bytes
  }
}

function resolveLocalEndpoint(): { localIp: string | null; interfaceName: string | null } {
  const interfaces = os.networkInterfaces()
  const candidates: Array<{ localIp: string; interfaceName: string; score: number }> = []

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const family = String(entry.family)
      if ((family !== 'IPv4' && family !== '4') || entry.internal) {
        continue
      }
      const lower = name.toLowerCase()
      let score = 10
      if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan')) {
        score = 30
      } else if (lower.includes('ethernet') || lower.includes('eth') || lower.startsWith('en')) {
        score = 40
      } else if (lower.includes('vpn') || lower.includes('tun') || lower.includes('tap') || lower.includes('ppp')) {
        score = 5
      }
      if (entry.address.startsWith('192.168.') || entry.address.startsWith('10.')) {
        score += 5
      }
      candidates.push({ localIp: entry.address, interfaceName: name, score })
    }
  }

  candidates.sort((left, right) => right.score - left.score)
  const best = candidates[0]
  return best
    ? { localIp: best.localIp, interfaceName: best.interfaceName }
    : { localIp: null, interfaceName: null }
}

function fetchCloudflareTrace(): Promise<{ publicIp: string | null; colo: string | null }> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        hostname: BASE_HOST,
        path: '/cdn-cgi/trace',
        headers: { 'cache-control': 'no-store' }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          if (!isOk(response)) {
            reject(new Error(`Gagal membaca info jaringan (${response.statusCode})`))
            return
          }
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({
            publicIp: matchTrace(body, 'ip'),
            colo: matchTrace(body, 'colo')
          })
        })
      }
    )
    request.setTimeout(10_000, () => request.destroy(new Error('Timeout info jaringan')))
    request.on('error', reject)
  })
}

function matchTrace(body: string, key: string): string | null {
  const match = body.match(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`, 'i'))
  return match?.[1]?.trim() || null
}

function trimmedMean(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  if (values.length < 4) {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }
  const sorted = [...values].sort((a, b) => a - b)
  const trim = Math.max(1, Math.floor(sorted.length * 0.15))
  const sliced = sorted.slice(trim, sorted.length - trim)
  return sliced.reduce((sum, value) => sum + value, 0) / sliced.length
}

function isOk(response: IncomingMessage): boolean {
  return Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300)
}

function bytesToMbps(bytes: number, seconds: number): number {
  return (bytes * 8) / seconds / 1_000_000
}

function roundMbps(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  if (value >= 100) {
    return Math.round(value)
  }
  return Math.round(value * 10) / 10
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
