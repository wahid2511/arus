import type { DownloadsApi, SpeedTestApi } from '../shared/downloadTypes'

interface WindowControlsApi {
  minimize(): void
  maximize(): void
  close(): void
}

declare global {
  interface Window {
    downloads: DownloadsApi
    speedTest: SpeedTestApi
    windowControls?: WindowControlsApi
  }
}

export {}
