import { BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'
import { IPC_EVENTS } from '../../shared/ipcChannels'
import { appState } from '../app/state'
import { syncDockVisibility } from '../system/dock'
import { resolveAppIcon } from './appIcon'

export function createCaptureWindow(): void {
  if (appState.captureWindow) {
    return
  }

  const iconPath = resolveAppIcon()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined
  appState.captureWindow = new BrowserWindow({
    show: false,
    width: 520,
    height: 365,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'Konfirmasi unduhan Arus',
    backgroundColor: '#12181F',
    frame: false,
    icon: icon && !icon.isEmpty() ? icon : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL)
    rendererUrl.searchParams.set('view', 'capture')
    void appState.captureWindow.loadURL(rendererUrl.toString())
  } else {
    void appState.captureWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'capture' }
    })
  }

  appState.captureWindow.webContents.on('did-finish-load', () => publishActivePending())
  appState.captureWindow.once('ready-to-show', () => {
    if (appState.activePendingId) {
      appState.captureWindow?.show()
      appState.captureWindow?.focus()
      syncDockVisibility()
    }
  })
  appState.captureWindow.on('close', (event) => {
    if (!appState.isQuitting) {
      event.preventDefault()
      if (appState.activePendingId) {
        appState.pendingDownloads?.remove(appState.activePendingId)
        appState.activePendingId = null
      }
      appState.captureWindow?.hide()
      syncDockVisibility()
      showNextPending()
    }
  })
  appState.captureWindow.on('closed', () => {
    appState.captureWindow = null
  })
}

export function publishActivePending(): void {
  if (!appState.captureWindow || appState.captureWindow.isDestroyed()) {
    return
  }
  const pending = appState.activePendingId
    ? appState.pendingDownloads?.list().find((item) => item.id === appState.activePendingId) || null
    : null
  appState.captureWindow.webContents.send(IPC_EVENTS.downloadsPending, pending)
}

export function showNextPending(): void {
  const next = appState.pendingDownloads?.list()[0] || null
  appState.activePendingId = next?.id || null
  if (!next) {
    publishActivePending()
    appState.captureWindow?.hide()
    return
  }

  createCaptureWindow()
  publishActivePending()
  if (appState.captureWindow && !appState.captureWindow.webContents.isLoadingMainFrame()) {
    appState.captureWindow.show()
    appState.captureWindow.focus()
    syncDockVisibility()
  }
}

export function assertCaptureSender(event: Electron.IpcMainInvokeEvent): void {
  if (!appState.captureWindow || event.sender !== appState.captureWindow.webContents) {
    throw new Error('Pending download actions are only available to the confirmation window')
  }
}
