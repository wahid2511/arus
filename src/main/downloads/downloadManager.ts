import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddDownloadInput, AppSettings, DownloadTask, DownloadProgressEvent } from '../../shared/downloadTypes'
import { clampConnections, nameFromUrl, normalizeUrl, safeFileName } from '../../shared/fileNaming'
import {
  isAbortError,
  SegmentedDownloader
} from './segmentedDownloader'

type TaskUpdateHandler = (task: DownloadTask) => void
type ProgressHandler = (progress: DownloadProgressEvent) => void

type InternalTask = DownloadTask & {
  tempPath: string
  metaPath: string
  requestHeaders?: Record<string, string>
  downloader?: SegmentedDownloader
}

const MAX_CONCURRENT_DOWNLOADS = 3
const DEFAULT_SETTINGS: AppSettings = {
  connections: 8,
  revealOnComplete: true,
  browserIntegrationEnabled: true,
  launchAtLogin: true
}

export class DownloadManager {
  private readonly tasks = new Map<string, InternalTask>()
  private readonly onUpdate: TaskUpdateHandler
  private readonly onProgress: ProgressHandler
  private readonly statePath: string
  private readonly settingsPath: string
  private settings: AppSettings = { ...DEFAULT_SETTINGS }

  constructor(
    userDataPath: string,
    onUpdate: TaskUpdateHandler,
    onProgress: ProgressHandler = () => undefined
  ) {
    this.onUpdate = onUpdate
    this.onProgress = onProgress
    this.statePath = join(userDataPath, 'arus-downloads.json')
    this.settingsPath = join(userDataPath, 'arus-settings.json')
    this.settings = loadSettings(this.settingsPath)
    this.hydrate()
  }

  getSettings(): AppSettings {
    return { ...this.settings }
  }

  setSettings(partial: Partial<AppSettings>): AppSettings {
    if (typeof partial.connections === 'number') {
      this.settings.connections = clampConnections(partial.connections)
    }
    if (typeof partial.revealOnComplete === 'boolean') {
      this.settings.revealOnComplete = partial.revealOnComplete
    }
    if (typeof partial.browserIntegrationEnabled === 'boolean') {
      this.settings.browserIntegrationEnabled = partial.browserIntegrationEnabled
    }
    if (typeof partial.launchAtLogin === 'boolean') {
      this.settings.launchAtLogin = partial.launchAtLogin
    }
    saveSettings(this.settingsPath, this.settings)
    return this.getSettings()
  }

  add(input: AddDownloadInput, defaultDirectory: string): DownloadTask {
    const url = normalizeUrl(input.url)
    const directory = input.directory || defaultDirectory
    mkdirSync(directory, { recursive: true })

    const preferredName = input.fileName
      ? safeFileName(input.fileName, 'download.bin')
      : safeFileName(nameFromUrl(url, 'download.bin'), 'download.bin')
    const filePath = uniquePath(join(directory, preferredName))
    const now = Date.now()
    const requestHeaders = normalizeHeaders(input.headers, input.referrer)
    const task: InternalTask = {
      id: randomUUID(),
      url,
      fileName: filePath.split(/[\\/]/).pop() || preferredName,
      filePath,
      directory,
      status: 'queued',
      progress: 0,
      bytesReceived: 0,
      totalBytes: null,
      speedBytesPerSecond: 0,
      createdAt: now,
      updatedAt: now,
      tempPath: `${filePath}.part`,
      metaPath: `${filePath}.part.meta.json`,
      requestHeaders
    }

    this.tasks.set(task.id, task)
    this.persist()
    this.emit(task)
    this.pumpQueue()
    return snapshot(task)
  }

  list(): DownloadTask[] {
    return [...this.tasks.values()].map(snapshot)
  }

  pause(id: string): DownloadTask {
    const task = this.getTask(id)

    if (task.status === 'queued') {
      task.status = 'paused'
      this.persist()
      this.emit(task)
      return snapshot(task)
    }

    if (task.status === 'downloading') {
      task.downloader?.pause()
      task.status = 'paused'
      task.speedBytesPerSecond = 0
      this.persist()
      this.emit(task)
      this.pumpQueue()
    }

    return snapshot(task)
  }

  resume(id: string): DownloadTask {
    const task = this.getTask(id)

    if (task.status !== 'paused' && task.status !== 'failed' && task.status !== 'cancelled') {
      return snapshot(task)
    }

    if (task.status === 'cancelled') {
      task.bytesReceived = 0
      task.progress = 0
      task.totalBytes = null
      removeQuiet(task.metaPath)
      removeQuiet(task.tempPath)
    }

    task.error = undefined
    task.status = 'queued'
    task.speedBytesPerSecond = 0
    this.persist()
    this.emit(task)
    this.pumpQueue()
    return snapshot(task)
  }

  cancel(id: string): DownloadTask {
    const task = this.getTask(id)

    task.downloader?.cancel()
    task.status = 'cancelled'
    task.speedBytesPerSecond = 0
    task.downloader = undefined
    removeQuiet(task.tempPath)
    removeQuiet(task.metaPath)
    this.persist()
    this.emit(task)
    this.pumpQueue()
    return snapshot(task)
  }

  remove(id: string): void {
    const task = this.getTask(id)

    if (task.status === 'downloading') {
      this.cancel(id)
    } else {
      removeQuiet(task.tempPath)
      removeQuiet(task.metaPath)
    }

    this.tasks.delete(id)
    this.persist()
  }

  pauseAll(): DownloadTask[] {
    const targets = [...this.tasks.values()].filter(
      (task) => task.status === 'downloading' || task.status === 'queued'
    )
    return targets.map((task) => this.pause(task.id))
  }

  resumeMany(ids: string[]): DownloadTask[] {
    return ids
      .map((id) => {
        try {
          return this.resume(id)
        } catch {
          return null
        }
      })
      .filter((task): task is DownloadTask => Boolean(task))
  }

  pauseMany(ids: string[]): DownloadTask[] {
    return ids
      .map((id) => {
        try {
          return this.pause(id)
        } catch {
          return null
        }
      })
      .filter((task): task is DownloadTask => Boolean(task))
  }

  removeMany(ids: string[]): void {
    ids.forEach((id) => {
      try {
        this.remove(id)
      } catch {
        // ignore missing
      }
    })
  }

  removeCompleted(): void {
    const completed = [...this.tasks.values()]
      .filter((task) => task.status === 'completed')
      .map((task) => task.id)
    this.removeMany(completed)
  }

  getFilePath(id: string): string {
    return this.getTask(id).filePath
  }

  private pumpQueue(): void {
    const activeCount = [...this.tasks.values()].filter((task) => task.status === 'downloading').length
    const freeSlots = MAX_CONCURRENT_DOWNLOADS - activeCount
    if (freeSlots <= 0) {
      return
    }

    const queued = [...this.tasks.values()].filter((task) => task.status === 'queued').slice(0, freeSlots)
    queued.forEach((task) => void this.start(task))
  }

  private async start(task: InternalTask): Promise<void> {
    task.status = 'downloading'
    task.error = undefined
    task.speedBytesPerSecond = 0
    this.emit(task)

    const downloader = new SegmentedDownloader({
      id: task.id,
      url: task.url,
      filePath: task.filePath,
      tempPath: task.tempPath,
      metaPath: task.metaPath,
      connections: this.settings.connections,
      requestHeaders: task.requestHeaders,
      onProgress: (progress) => this.handleProgress(task, progress)
    })

    task.downloader = downloader

    try {
      await downloader.start()
      if (task.status !== 'downloading') {
        return
      }

      task.status = 'completed'
      task.progress = 100
      task.bytesReceived = task.totalBytes ?? task.bytesReceived
      task.speedBytesPerSecond = 0
      task.downloader = undefined
      this.persist()
      this.emit(task)
    } catch (error) {
      task.downloader = undefined
      const statusWhenFailed = task.status as DownloadTask['status']

      if (isAbortError(error)) {
        if (error.reason === 'paused' || statusWhenFailed === 'paused') {
          task.status = 'paused'
        } else if (statusWhenFailed !== 'cancelled') {
          task.status = 'cancelled'
        }
        task.speedBytesPerSecond = 0
        this.persist()
        this.emit(task)
        return
      }

      if (statusWhenFailed === 'paused' || statusWhenFailed === 'cancelled') {
        return
      }

      task.status = 'failed'
      task.speedBytesPerSecond = 0
      task.error = error instanceof Error ? error.message : 'Download failed'
      this.persist()
      this.emit(task)
    } finally {
      this.pumpQueue()
    }
  }

  private handleProgress(task: InternalTask, progress: DownloadProgressEvent): void {
    if (task.status !== 'downloading') {
      return
    }

    task.bytesReceived = progress.downloadedBytes
    task.totalBytes = progress.totalBytes
    task.progress = progress.percent
    task.speedBytesPerSecond = progress.speedBytesPerSecond
    task.segments = progress.segments
    this.emit(task)
    this.onProgress(progress)
  }

  private hydrate(): void {
    if (!existsSync(this.statePath)) {
      return
    }

    try {
      const raw = readFileSync(this.statePath, 'utf8')
      const parsed = JSON.parse(raw) as DownloadTask[]
      if (!Array.isArray(parsed)) {
        return
      }

      for (const item of parsed) {
        const task: InternalTask = {
          ...item,
          tempPath: `${item.filePath}.part`,
          metaPath: `${item.filePath}.part.meta.json`,
          speedBytesPerSecond: 0,
          segments: item.segments ?? readSegmentsFromMeta(`${item.filePath}.part.meta.json`)
        }

        if (task.status === 'downloading' || task.status === 'queued') {
          task.status = 'paused'
        }

        this.tasks.set(task.id, task)
      }
    } catch {
      // ignore corrupt state
    }
  }

  private persist(): void {
    const payload = [...this.tasks.values()].map(snapshot)
    try {
      writeFileSync(this.statePath, JSON.stringify(payload, null, 2))
    } catch {
      // ignore
    }
  }

  private getTask(id: string): InternalTask {
    const task = this.tasks.get(id)
    if (!task) {
      throw new Error('Download task not found')
    }
    return task
  }

  private emit(task: InternalTask): void {
    task.updatedAt = Date.now()
    this.onUpdate(snapshot(task))
  }
}

function loadSettings(path: string): AppSettings {
  try {
    if (!existsSync(path)) {
      const fresh = { ...DEFAULT_SETTINGS }
      saveSettings(path, fresh)
      return fresh
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppSettings> & {
      extensionBridgeEnabled?: boolean
    }
    // Migrate legacy HTTP-bridge toggle → native messaging browser integration.
    const browserIntegrationEnabled =
      typeof parsed.browserIntegrationEnabled === 'boolean'
        ? parsed.browserIntegrationEnabled
        : typeof parsed.extensionBridgeEnabled === 'boolean'
          ? parsed.extensionBridgeEnabled
          : DEFAULT_SETTINGS.browserIntegrationEnabled

    const settings: AppSettings = {
      connections: clampConnections(parsed.connections ?? DEFAULT_SETTINGS.connections),
      revealOnComplete:
        typeof parsed.revealOnComplete === 'boolean'
          ? parsed.revealOnComplete
          : DEFAULT_SETTINGS.revealOnComplete,
      browserIntegrationEnabled,
      launchAtLogin:
        typeof parsed.launchAtLogin === 'boolean'
          ? parsed.launchAtLogin
          : DEFAULT_SETTINGS.launchAtLogin
    }
    saveSettings(path, settings)
    return settings
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(path: string, settings: AppSettings): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(settings, null, 2))
  } catch {
    // ignore
  }
}

function normalizeHeaders(
  headers: Record<string, string> | undefined,
  referrer: string | undefined
): Record<string, string> | undefined {
  const next: Record<string, string> = { ...(headers || {}) }
  if (referrer && !next.Referer && !next.referer) {
    next.Referer = referrer
  }
  const keys = Object.keys(next)
  return keys.length ? next : undefined
}

function uniquePath(filePath: string): string {
  if (!existsSync(filePath) && !existsSync(`${filePath}.part`)) {
    return filePath
  }

  const dir = dirname(filePath)
  const extension = extname(filePath)
  const base = filePath.slice(dir.length + 1, filePath.length - extension.length)
  let index = 1

  while (true) {
    const candidate = join(dir, `${base} (${index})${extension}`)
    if (!existsSync(candidate) && !existsSync(`${candidate}.part`)) {
      return candidate
    }
    index += 1
  }
}

function removeQuiet(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path)
    }
  } catch {
    // ignore
  }
}

function snapshot(task: InternalTask): DownloadTask {
  return {
    id: task.id,
    url: task.url,
    fileName: task.fileName,
    filePath: task.filePath,
    directory: task.directory,
    status: task.status,
    progress: task.progress,
    bytesReceived: task.bytesReceived,
    totalBytes: task.totalBytes,
    speedBytesPerSecond: task.speedBytesPerSecond,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error,
    segments: task.segments
  }
}

function readSegmentsFromMeta(metaPath: string): DownloadTask['segments'] {
  try {
    if (!existsSync(metaPath)) {
      return undefined
    }
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      segments?: DownloadTask['segments']
    }
    return Array.isArray(parsed.segments) ? parsed.segments : undefined
  } catch {
    return undefined
  }
}
