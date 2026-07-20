const DEFAULT_CONNECTIONS = 8
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 3
const DEFAULT_MIN_SEGMENT_SIZE_BYTES = 512 * 1024
const DEFAULT_MAX_SEGMENT_RETRIES = 3

export function clampConnections(value: number, fallback = DEFAULT_CONNECTIONS): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(16, Math.max(4, Math.round(value)))
}

export function clampMaxConcurrentDownloads(
  value: number,
  fallback = DEFAULT_MAX_CONCURRENT_DOWNLOADS
): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(10, Math.max(1, Math.round(value)))
}

export function clampMinSegmentSizeBytes(
  value: number,
  fallback = DEFAULT_MIN_SEGMENT_SIZE_BYTES
): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  // 64 KiB – 8 MiB keeps overhead sensible without starving parallelism.
  return Math.min(8 * 1024 * 1024, Math.max(64 * 1024, Math.round(value)))
}

export function clampMaxSegmentRetries(
  value: number,
  fallback = DEFAULT_MAX_SEGMENT_RETRIES
): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(10, Math.max(0, Math.round(value)))
}

export function normalizeUrl(value: string): string {
  const parsed = new URL(value.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are supported')
  }
  return parsed.toString()
}

export function nameFromUrl(url: string, fallback = 'download'): string {
  try {
    const pathname = new URL(url).pathname
    const raw = pathname.split('/').filter(Boolean).pop()
    return raw ? decodeURIComponent(raw) : fallback
  } catch {
    return fallback
  }
}

export function safeFileName(value: string, fallback = 'download'): string {
  const safe = value
    .split(/[\\/]/)
    .pop()!
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return safe || fallback
}
