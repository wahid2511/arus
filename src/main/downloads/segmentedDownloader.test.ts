import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SegmentedDownloader } from './segmentedDownloader'
import { createHttpDownloadServer } from '../../test/httpDownloadServer'

type TempPaths = {
  dir: string
  filePath: string
  tempPath: string
  metaPath: string
}

async function makeTempPaths(name: string): Promise<TempPaths> {
  const dir = await mkdtemp(join(tmpdir(), `arus-${name}-`))
  const filePath = join(dir, 'download.bin')
  return {
    dir,
    filePath,
    tempPath: `${filePath}.part`,
    metaPath: `${filePath}.part.meta.json`
  }
}

describe('SegmentedDownloader', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()
      await cleanup?.()
    }
  })

  it('downloads with dynamic segmentation and produces byte-identical output', async () => {
    const body = Buffer.alloc(2 * 1024 * 1024, 0)
    for (let i = 0; i < body.length; i += 1) {
      body[i] = i % 251
    }

    const server = await createHttpDownloadServer({
      body,
      supportRanges: true,
      etag: '"v1-dynamic"',
      contentDisposition: 'attachment; filename="payload.bin"'
    })
    const paths = await makeTempPaths('segmented')
    cleanups.push(async () => {
      await server.close()
      await rm(paths.dir, { recursive: true, force: true })
    })

    const seenSegments: number[] = []
    const downloader = new SegmentedDownloader({
      id: 'task-1',
      url: server.url,
      filePath: paths.filePath,
      tempPath: paths.tempPath,
      metaPath: paths.metaPath,
      connections: 4,
      minSegmentSizeBytes: 128 * 1024,
      maxRetries: 2,
      onProgress: (progress) => {
        if (progress.segments) {
          seenSegments.push(progress.segments.length)
        }
      }
    })

    await downloader.start()

    const result = await readFile(paths.filePath)
    expect(result.equals(body)).toBe(true)
    expect(Math.max(...seenSegments, 1)).toBeGreaterThan(1)
    expect(existsSync(paths.tempPath)).toBe(false)
    expect(existsSync(paths.metaPath)).toBe(false)
    expect(existsSync(`${paths.metaPath}.tmp`)).toBe(false)

    const rangeGets = server.requests.filter(
      (request) => request.method === 'GET' && request.range
    )
    expect(rangeGets.length).toBeGreaterThan(1)
  })

  it('recreates a destination folder that disappeared before the task resumed', async () => {
    const body = Buffer.from('folder-recovery-payload')
    const server = await createHttpDownloadServer({ body, supportRanges: false })
    const root = await mkdtemp(join(tmpdir(), 'arus-missing-folder-'))
    const directory = join(root, 'deleted', 'Downloads')
    const filePath = join(directory, 'download.bin')
    const paths: TempPaths = {
      dir: root,
      filePath,
      tempPath: `${filePath}.part`,
      metaPath: `${filePath}.part.meta.json`
    }
    cleanups.push(async () => {
      await server.close()
      await rm(paths.dir, { recursive: true, force: true })
    })

    const downloader = new SegmentedDownloader({
      id: 'task-missing-folder',
      url: server.url,
      filePath: paths.filePath,
      tempPath: paths.tempPath,
      metaPath: paths.metaPath,
      connections: 8,
      onProgress: () => undefined
    })

    await downloader.start()

    expect(await readFile(paths.filePath)).toEqual(body)
    expect(existsSync(directory)).toBe(true)
  })

  it('retries a dropped single-stream connection and resumes the partial file', async () => {
    const body = Buffer.alloc(128 * 1024, 4)
    for (let i = 0; i < body.length; i += 1) {
      body[i] = (i * 11) % 256
    }

    const server = await createHttpDownloadServer({
      body,
      supportRanges: false,
      failFullGets: 1
    })
    const paths = await makeTempPaths('single-retry')
    cleanups.push(async () => {
      await server.close()
      await rm(paths.dir, { recursive: true, force: true })
    })

    const downloader = new SegmentedDownloader({
      id: 'task-single-retry',
      url: server.url,
      filePath: paths.filePath,
      tempPath: paths.tempPath,
      metaPath: paths.metaPath,
      connections: 8,
      maxRetries: 1,
      onProgress: () => undefined
    })

    await downloader.start()

    expect(await readFile(paths.filePath)).toEqual(body)
    expect(server.requests.filter((request) => request.method === 'GET' && !request.range)).toHaveLength(2)
  })

  it('resumes from persisted meta without re-downloading completed bytes', async () => {
    const body = Buffer.alloc(1024 * 1024, 7)
    for (let i = 0; i < body.length; i += 1) {
      body[i] = (i * 3) % 256
    }

    const server = await createHttpDownloadServer({
      body,
      supportRanges: true,
      etag: '"resume-etag"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT'
    })
    const paths = await makeTempPaths('resume')
    cleanups.push(async () => {
      await server.close()
      await rm(paths.dir, { recursive: true, force: true })
    })

    // Seed a partial preallocated file + versioned checkpoint as if we paused mid-download.
    const half = Math.floor(body.length / 2)
    const part = Buffer.alloc(body.length, 0)
    body.copy(part, 0, 0, half)
    await writeFile(paths.tempPath, part)
    await writeFile(
      paths.metaPath,
      JSON.stringify({
        version: 2,
        url: server.url,
        totalBytes: body.length,
        connections: 4,
        minSegmentSizeBytes: 64 * 1024,
        segments: [
          { index: 0, start: 0, end: half - 1, downloaded: half },
          { index: 1, start: half, end: body.length - 1, downloaded: 0 }
        ],
        etag: '"resume-etag"',
        lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
        contentMd5: null,
        contentDisposition: null,
        mode: 'segmented'
      })
    )

    const requestsBeforeResume = server.requests.length

    const downloader = new SegmentedDownloader({
      id: 'task-resume',
      url: server.url,
      filePath: paths.filePath,
      tempPath: paths.tempPath,
      metaPath: paths.metaPath,
      connections: 4,
      minSegmentSizeBytes: 64 * 1024,
      maxRetries: 2,
      onProgress: () => undefined
    })
    await downloader.start()

    const result = await readFile(paths.filePath)
    expect(result.equals(body)).toBe(true)
    expect(existsSync(paths.tempPath)).toBe(false)
    expect(existsSync(paths.metaPath)).toBe(false)

    const resumeRanges = server.requests
      .slice(requestsBeforeResume)
      .filter((request) => request.method === 'GET' && request.range)
    expect(resumeRanges.length).toBeGreaterThan(0)
    // Resumed work should request bytes from the unfinished half (not restart at 0).
    expect(
      resumeRanges.some((request) => {
        const match = /^bytes=(\d+)-/.exec(request.range || '')
        return match ? Number(match[1]) >= half : false
      })
    ).toBe(true)
    // Completed first half must not be requested again from byte 0 as a full-file range.
    expect(
      resumeRanges.every((request) => {
        const match = /^bytes=(\d+)-/.exec(request.range || '')
        if (!match) {
          return true
        }
        const start = Number(match[1])
        // Probe uses 0-0; segmented resume for incomplete work starts at >= half.
        return start === 0 || start >= half
      })
    ).toBe(true)
  })

  it('falls back to a single connection when the server rejects ranges', async () => {
    const body = Buffer.from('hello-arus-single-stream-payload-0123456789')
    const server = await createHttpDownloadServer({
      body,
      supportRanges: false,
      rejectHead: true
    })
    const paths = await makeTempPaths('norange')
    cleanups.push(async () => {
      await server.close()
      await rm(paths.dir, { recursive: true, force: true })
    })

    let maxSegments = 0
    const downloader = new SegmentedDownloader({
      id: 'task-single',
      url: server.url,
      filePath: paths.filePath,
      tempPath: paths.tempPath,
      metaPath: paths.metaPath,
      connections: 8,
      minSegmentSizeBytes: 64 * 1024,
      onProgress: (progress) => {
        maxSegments = Math.max(maxSegments, progress.segments?.length ?? 0)
      }
    })

    await downloader.start()

    const result = await readFile(paths.filePath)
    expect(result.equals(body)).toBe(true)
    expect(maxSegments).toBe(0)

    const rangeGets = server.requests.filter(
      (request) => request.method === 'GET' && request.range && request.range !== 'bytes=0-0'
    )
    // Probe may use bytes=0-0; after fallback no multi-range segmented GETs.
    expect(rangeGets.length).toBe(0)
  })

  it('uses single-stream when HEAD advertises ranges but Range GETs return 403', async () => {
    const body = Buffer.alloc(256 * 1024, 9)
    for (let i = 0; i < body.length; i += 1) {
      body[i] = (i * 7) % 256
    }

    const server = await createHttpDownloadServer({
      body,
      supportRanges: true,
      rejectRangeWithStatus: 403,
      etag: '"anti-leech"'
    })
    const paths = await makeTempPaths('antihotlink')
    cleanups.push(async () => {
      await server.close()
      await rm(paths.dir, { recursive: true, force: true })
    })

    let maxSegments = 0
    const downloader = new SegmentedDownloader({
      id: 'task-403-range',
      url: server.url,
      filePath: paths.filePath,
      tempPath: paths.tempPath,
      metaPath: paths.metaPath,
      connections: 8,
      minSegmentSizeBytes: 32 * 1024,
      onProgress: (progress) => {
        maxSegments = Math.max(maxSegments, progress.segments?.length ?? 0)
      }
    })

    await downloader.start()

    const result = await readFile(paths.filePath)
    expect(result.equals(body)).toBe(true)
    expect(maxSegments).toBe(0)

    // Full-body GET (no Range) must succeed after probe Range was rejected.
    const fullGets = server.requests.filter(
      (request) => request.method === 'GET' && !request.range
    )
    expect(fullGets.length).toBeGreaterThan(0)
    expect(fullGets.some((request) => request.headers['user-agent'])).toBe(true)
    expect(fullGets.some((request) => request.headers.referer)).toBe(true)
  })

  it('validates Content-MD5 when the server provides it', async () => {
    const body = Buffer.from('checksum-me-please')
    const md5 = createHash('md5').update(body).digest('base64')
    const server = await createHttpDownloadServer({
      body,
      supportRanges: true,
      contentMd5: md5,
      etag: '"md5-file"'
    })
    const paths = await makeTempPaths('md5')
    cleanups.push(async () => {
      await server.close()
      await rm(paths.dir, { recursive: true, force: true })
    })

    const downloader = new SegmentedDownloader({
      id: 'task-md5',
      url: server.url,
      filePath: paths.filePath,
      tempPath: paths.tempPath,
      metaPath: paths.metaPath,
      connections: 4,
      minSegmentSizeBytes: 8,
      onProgress: () => undefined
    })

    await downloader.start()
    expect(await readFile(paths.filePath)).toEqual(body)
  })
})
