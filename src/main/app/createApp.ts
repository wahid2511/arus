import { app } from 'electron'
import { IPC_EVENTS } from '../../shared/ipcChannels'
import { appState } from './state'
import { DownloadManager } from '../downloads/downloadManager'
import { maybeRevealOnComplete } from '../downloads/pathReveal'
import { PendingDownloadManager } from '../downloads/pendingDownloadManager'
import { registerIpcHandlers } from '../ipc/registerIpc'
import { NativeBridgeServer } from '../nativeMessaging/bridgeServer'
import { installNativeMessagingHost } from '../nativeMessaging/register'
import { applyLoginItemSetting, shouldStartHidden } from '../system/loginItem'
import { syncDockVisibility } from '../system/dock'
import { createTray, scheduleTrayMenuRefresh } from '../tray/trayController'
import { showNextPending } from '../windows/captureWindow'
import { focusMainWindow } from '../windows/mainWindow'
import type { DownloadProgressEvent, DownloadTask } from '../../shared/downloadTypes'

export async function createApp(): Promise<void> {
  appState.downloads = new DownloadManager(
    app.getPath('userData'),
    (task: DownloadTask) => {
      appState.mainWindow?.webContents.send(IPC_EVENTS.downloadsUpdated, task)
      scheduleTrayMenuRefresh()
      maybeRevealOnComplete(task)
    },
    (progress: DownloadProgressEvent) => {
      appState.mainWindow?.webContents.send(IPC_EVENTS.downloadProgress, progress)
      scheduleTrayMenuRefresh()
    }
  )
  appState.pendingDownloads = new PendingDownloadManager(app.getPath('downloads'))

  appState.nativeBridge = new NativeBridgeServer({
    isEnabled: () => appState.downloads!.getSettings().browserIntegrationEnabled,
    proposeDownload: (input) => appState.pendingDownloads!.propose(input),
    onDownloadProposed: () => showNextPending(),
    getVersion: () => app.getVersion()
  })

  registerIpcHandlers()
  createTray()
  applyLoginItemSetting(appState.downloads.getSettings().launchAtLogin)

  if (appState.downloads.getSettings().browserIntegrationEnabled) {
    appState.lastHostInstall = installNativeMessagingHost()
    try {
      await appState.nativeBridge.start()
    } catch (error) {
      console.error('[arus] native bridge failed to start:', error)
    }
  }

  if (!shouldStartHidden()) {
    focusMainWindow()
  } else {
    syncDockVisibility()
  }

  app.on('activate', () => {
    focusMainWindow()
  })
}
