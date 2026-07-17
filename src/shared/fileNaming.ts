const DEFAULT_CONNECTIONS = 8

export function clampConnections(value: number, fallback = DEFAULT_CONNECTIONS): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(16, Math.max(4, Math.round(value)))
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
