export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DownloadSegment {
  index: number
  start: number
  end: number
  downloaded: number
}

export interface DownloadTask {
  id: string
  url: string
  fileName: string
  filePath: string
  directory: string
  status: DownloadStatus
  progress: number
  bytesReceived: number
  totalBytes: number | null
  speedBytesPerSecond: number
  createdAt: number
  updatedAt: number
  error?: string
  /** Present when multi-connection segmented download is in use. */
  segments?: DownloadSegment[]
}

export interface AddDownloadInput {
  url: string
  directory?: string
  referrer?: string
  fileName?: string
  /** Extra HTTP headers (Cookie, Referer, User-Agent, …) from the browser. */
  headers?: Record<string, string>
}

export interface PendingDownload {
  id: string
  requestId?: string
  url: string
  directory: string
  referrer?: string
  fileName: string
  fileSize?: number | null
  headers?: Record<string, string>
  createdAt: number
}

export interface ConfirmPendingDownloadInput {
  id: string
  directory?: string
  fileName?: string
}

export interface DownloadProgressEvent {
  id: string
  downloadedBytes: number
  totalBytes: number | null
  speedBytesPerSecond: number
  percent: number
  segments?: DownloadSegment[]
}

export interface AppSettings {
  /** Parallel connections per download (4–16). */
  connections: number
  /** Reveal the file in Explorer/Finder when a download finishes. */
  revealOnComplete: boolean
  /** Accept downloads from browser extensions via native messaging. */
  browserIntegrationEnabled: boolean
  /** Start the installed app hidden in the menu bar / system tray at OS login. */
  launchAtLogin: boolean
}

export interface BrowserIntegrationStatus {
  enabled: boolean
  bridgeListening: boolean
  hostInstalled: boolean
  hostName: string
  chromeExtensionId: string
  firefoxExtensionId: string
  extensionPath: string | null
  loginItemSupported: boolean
  lastError?: string
}

export interface DownloadsApi {
  add(input: AddDownloadInput): Promise<DownloadTask>
  list(): Promise<DownloadTask[]>
  pause(id: string): Promise<DownloadTask>
  resume(id: string): Promise<DownloadTask>
  cancel(id: string): Promise<DownloadTask>
  remove(id: string): Promise<void>
  pauseAll(): Promise<DownloadTask[]>
  resumeMany(ids: string[]): Promise<DownloadTask[]>
  pauseMany(ids: string[]): Promise<DownloadTask[]>
  removeMany(ids: string[]): Promise<void>
  removeCompleted(): Promise<void>
  revealInFolder(id: string): Promise<boolean>
  chooseDirectory(): Promise<string | null>
  getSettings(): Promise<AppSettings>
  setSettings(settings: Partial<AppSettings>): Promise<AppSettings>
  getBrowserIntegrationStatus(): Promise<BrowserIntegrationStatus>
  installNativeHost(): Promise<BrowserIntegrationStatus>
  openExtensionFolder(): Promise<string | null>
  listPending(): Promise<PendingDownload[]>
  confirmPending(input: ConfirmPendingDownloadInput): Promise<DownloadTask>
  rejectPending(id: string): Promise<void>
  onPending(callback: (pending: PendingDownload | null) => void): () => void
  onUpdated(callback: (task: DownloadTask) => void): () => void
  onSnapshot(callback: (tasks: DownloadTask[]) => void): () => void
  onProgress(callback: (progress: DownloadProgressEvent) => void): () => void
}
