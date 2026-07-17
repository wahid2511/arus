import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AddDownloadInput,
  AppSettings,
  ConfirmPendingDownloadInput
} from '../../shared/downloadTypes'
import { IPC, IPC_EVENTS } from '../../shared/ipcChannels'
import { appState } from '../app/state'
import { revealPathInFolder } from '../downloads/pathReveal'
import { getBrowserIntegrationStatus, registerHost } from './browserIntegration'
import { installNativeMessagingHost, resolveExtensionDistPath } from '../nativeMessaging/register'
import { applyLoginItemSetting } from '../system/loginItem'
import { refreshTrayMenu } from '../tray/trayController'
import {
  assertCaptureSender,
  showNextPending
} from '../windows/captureWindow'

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.downloads.add, (_event, input: AddDownloadInput) =>
    appState.downloads!.add(input, app.getPath('downloads'))
  )
  ipcMain.handle(IPC.downloads.list, () => appState.downloads!.list())
  ipcMain.handle(IPC.downloads.pause, (_event, id: string) => appState.downloads!.pause(id))
  ipcMain.handle(IPC.downloads.resume, (_event, id: string) => appState.downloads!.resume(id))
  ipcMain.handle(IPC.downloads.cancel, (_event, id: string) => appState.downloads!.cancel(id))
  ipcMain.handle(IPC.downloads.remove, (_event, id: string) => {
    appState.downloads!.remove(id)
    refreshTrayMenu()
    appState.mainWindow?.webContents.send(IPC_EVENTS.downloadsSnapshot, appState.downloads!.list())
  })
  ipcMain.handle(IPC.downloads.pauseAll, () => {
    const result = appState.downloads!.pauseAll()
    appState.mainWindow?.webContents.send(IPC_EVENTS.downloadsSnapshot, appState.downloads!.list())
    return result
  })
  ipcMain.handle(IPC.downloads.resumeMany, (_event, ids: string[]) => {
    const result = appState.downloads!.resumeMany(ids)
    appState.mainWindow?.webContents.send(IPC_EVENTS.downloadsSnapshot, appState.downloads!.list())
    return result
  })
  ipcMain.handle(IPC.downloads.pauseMany, (_event, ids: string[]) => {
    const result = appState.downloads!.pauseMany(ids)
    appState.mainWindow?.webContents.send(IPC_EVENTS.downloadsSnapshot, appState.downloads!.list())
    return result
  })
  ipcMain.handle(IPC.downloads.removeMany, (_event, ids: string[]) => {
    appState.downloads!.removeMany(ids)
    refreshTrayMenu()
    appState.mainWindow?.webContents.send(IPC_EVENTS.downloadsSnapshot, appState.downloads!.list())
  })
  ipcMain.handle(IPC.downloads.removeCompleted, () => {
    appState.downloads!.removeCompleted()
    refreshTrayMenu()
    appState.mainWindow?.webContents.send(IPC_EVENTS.downloadsSnapshot, appState.downloads!.list())
  })
  ipcMain.handle(IPC.downloads.revealInFolder, async (_event, id: string) => {
    try {
      return await revealPathInFolder(appState.downloads!.getFilePath(id))
    } catch {
      return false
    }
  })
  ipcMain.handle(IPC.downloads.chooseDirectory, async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Pilih folder unduhan',
      properties: ['openDirectory', 'createDirectory']
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)

    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.downloads.getSettings, () => appState.downloads!.getSettings())
  ipcMain.handle(IPC.downloads.setSettings, async (_event, settings: Partial<AppSettings>) => {
    const next = appState.downloads!.setSettings(settings)
    applyLoginItemSetting(next.launchAtLogin)
    try {
      if (next.browserIntegrationEnabled) {
        appState.lastHostInstall = installNativeMessagingHost()
        await appState.nativeBridge!.restart()
      } else {
        await appState.nativeBridge!.stop()
      }
    } catch (error) {
      console.error('[arus] native bridge restart failed:', error)
    }
    return next
  })
  ipcMain.handle(IPC.downloads.browserIntegrationStatus, () => getBrowserIntegrationStatus())
  ipcMain.handle(IPC.downloads.installNativeHost, () => registerHost())
  ipcMain.handle(IPC.downloads.openExtensionFolder, async () => {
    const path = resolveExtensionDistPath()
    if (!path) {
      return null
    }
    await shell.openPath(path)
    return path
  })
  ipcMain.handle(IPC.downloads.listPending, (event) => {
    assertCaptureSender(event)
    return appState.pendingDownloads!.list()
  })
  ipcMain.handle(IPC.downloads.confirmPending, (event, input: ConfirmPendingDownloadInput) => {
    assertCaptureSender(event)
    const pending = appState.pendingDownloads!.get(input.id)
    const task = appState.downloads!.add(
      {
        url: pending.url,
        directory: input.directory?.trim() || pending.directory,
        referrer: pending.referrer,
        fileName: input.fileName?.trim() || pending.fileName,
        headers: pending.headers
      },
      app.getPath('downloads')
    )
    appState.pendingDownloads!.remove(pending.id)
    appState.activePendingId = null
    showNextPending()
    return task
  })
  ipcMain.handle(IPC.downloads.rejectPending, (event, id: string) => {
    assertCaptureSender(event)
    appState.pendingDownloads!.remove(id)
    if (appState.activePendingId === id) {
      appState.activePendingId = null
    }
    showNextPending()
  })

  ipcMain.on(IPC.window.minimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on(IPC.window.maximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return
    }
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.on(IPC.window.close, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
