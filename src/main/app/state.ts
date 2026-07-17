import type { BrowserWindow, Tray } from 'electron'
import type { DownloadManager } from '../downloads/downloadManager'
import type { PendingDownloadManager } from '../downloads/pendingDownloadManager'
import type { NativeBridgeServer } from '../nativeMessaging/bridgeServer'
import type { NativeHostInstallResult } from '../nativeMessaging/register'

export const appState = {
  mainWindow: null as BrowserWindow | null,
  captureWindow: null as BrowserWindow | null,
  tray: null as Tray | null,
  downloads: null as DownloadManager | null,
  pendingDownloads: null as PendingDownloadManager | null,
  nativeBridge: null as NativeBridgeServer | null,
  lastHostInstall: null as NativeHostInstallResult | null,
  activePendingId: null as string | null,
  isQuitting: false,
  trayRefreshTimer: null as ReturnType<typeof setTimeout> | null
}
