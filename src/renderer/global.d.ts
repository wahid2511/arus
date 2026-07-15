import type { DownloadsApi } from '../shared/downloadTypes'

interface WindowControlsApi {
  minimize(): void
  maximize(): void
  close(): void
}

declare global {
  interface Window {
    downloads: DownloadsApi
    windowControls?: WindowControlsApi
  }
}

export {}
