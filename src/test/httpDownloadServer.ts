import http from 'node:http'
import type { AddressInfo } from 'node:net'

export type HttpRequestLog = {
  method: string
  url: string
  range: string | null
  headers: http.IncomingHttpHeaders
}

export type HttpFixtureOptions = {
  body: Buffer
  /** When false, Range requests are ignored and full 200 responses are returned. */
  supportRanges?: boolean
  /** When true, HEAD returns 405 and clients must fall back to GET. */
  rejectHead?: boolean
  etag?: string
  lastModified?: string
  contentMd5?: string
  contentDisposition?: string
  /** After this many successful range GETs, subsequent ranges return 200 (simulates lost support). */
  loseRangeAfterRequests?: number
}

export type HttpFixtureServer = {
  url: string
  port: number
  requests: HttpRequestLog[]
  close: () => Promise<void>
  setSupportRanges: (value: boolean) => void
}

export async function createHttpDownloadServer(
  options: HttpFixtureOptions
): Promise<HttpFixtureServer> {
  const requests: HttpRequestLog[] = []
  let supportRanges = options.supportRanges !== false
  let rangeGetCount = 0

  const server = http.createServer((req, res) => {
    const method = req.method || 'GET'
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : null
    requests.push({
      method,
      url: req.url || '/',
      range: rangeHeader,
      headers: { ...req.headers }
    })

    const commonHeaders: Record<string, string> = {
      'Content-Type': 'application/octet-stream'
    }
    if (options.etag) {
      commonHeaders.ETag = options.etag
    }
    if (options.lastModified) {
      commonHeaders['Last-Modified'] = options.lastModified
    }
    if (options.contentMd5) {
      commonHeaders['Content-MD5'] = options.contentMd5
    }
    if (options.contentDisposition) {
      commonHeaders['Content-Disposition'] = options.contentDisposition
    }

    if (method === 'HEAD') {
      if (options.rejectHead) {
        res.writeHead(405, { Allow: 'GET' })
        res.end()
        return
      }

      if (supportRanges) {
        commonHeaders['Accept-Ranges'] = 'bytes'
      }
      commonHeaders['Content-Length'] = String(options.body.length)
      res.writeHead(200, commonHeaders)
      res.end()
      return
    }

    if (method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }

    const wantsRange = Boolean(rangeHeader)
    if (wantsRange && supportRanges) {
      rangeGetCount += 1
      if (
        typeof options.loseRangeAfterRequests === 'number' &&
        rangeGetCount > options.loseRangeAfterRequests
      ) {
        // Pretend range support disappeared mid-download.
        commonHeaders['Content-Length'] = String(options.body.length)
        res.writeHead(200, commonHeaders)
        res.end(options.body)
        return
      }

      const parsed = parseRange(rangeHeader!, options.body.length)
      if (!parsed) {
        res.writeHead(416, {
          'Content-Range': `bytes */${options.body.length}`
        })
        res.end()
        return
      }

      const slice = options.body.subarray(parsed.start, parsed.end + 1)
      res.writeHead(206, {
        ...commonHeaders,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${parsed.start}-${parsed.end}/${options.body.length}`
      })
      res.end(slice)
      return
    }

    // No range support (or client did not ask): full body.
    commonHeaders['Content-Length'] = String(options.body.length)
    if (supportRanges) {
      commonHeaders['Accept-Ranges'] = 'bytes'
    }
    res.writeHead(200, commonHeaders)
    res.end(options.body)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/file.bin`,
    port: address.port,
    requests,
    setSupportRanges: (value: boolean) => {
      supportRanges = value
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

function parseRange(
  header: string,
  size: number
): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d+)?$/.exec(header.trim())
  if (!match) {
    return null
  }
  const start = Number(match[1])
  const end = match[2] != null ? Number(match[2]) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= size || start > end) {
    return null
  }
  return { start, end }
}
