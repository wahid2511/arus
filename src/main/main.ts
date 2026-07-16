import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { DownloadManager } from './downloadManager'
import { PendingDownloadManager } from './pendingDownloadManager'
import { NativeBridgeServer } from './nativeMessaging/bridgeServer'
import {
  CHROME_EXTENSION_ID,
  FIREFOX_EXTENSION_ID,
  NATIVE_HOST_NAME
} from './nativeMessaging/constants'
import {
  installNativeMessagingHost,
  resolveExtensionDistPath,
  type NativeHostInstallResult
} from './nativeMessaging/register'
import type {
  AddDownloadInput,
  AppSettings,
  BrowserIntegrationStatus,
  ConfirmPendingDownloadInput,
  DownloadTask
} from '../shared/downloadTypes'

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

if (process.platform === 'win32') {
  app.setAppUserModelId('com.genghero.arus')
}

let mainWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
let tray: Tray | null = null
let downloads: DownloadManager
let pendingDownloads: PendingDownloadManager
let nativeBridge: NativeBridgeServer
let lastHostInstall: NativeHostInstallResult | null = null
let activePendingId: string | null = null
let isQuitting = false
let trayRefreshTimer: ReturnType<typeof setTimeout> | null = null

const TRAY_DOWNLOAD_LIMIT = 8
const TRAY_REFRESH_INTERVAL_MS = 500
const TRAY_FILE_NAME_LENGTH = 42

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

function resolveAppIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icon.png'),
    join(__dirname, '../../resources/icon.png'),
    join(process.cwd(), 'resources', 'icon.png'),
    join(app.getAppPath(), 'resources', 'icon.png')
  ]
  return candidates.find((path) => existsSync(path))
}

function createWindow(): void {
  const iconPath = resolveAppIcon()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined

  mainWindow = new BrowserWindow({
    show: false,
    width: 860,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: 'Arus',
    backgroundColor: '#12181F',
    frame: false,
    transparent: false,
    roundedCorners: true,
    icon: icon && !icon.isEmpty() ? icon : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function focusMainWindow(): void {
  if (!mainWindow) {
    createWindow()
  }
  if (!mainWindow) {
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

function trayTaskPriority(task: DownloadTask): number {
  if (task.status === 'downloading') {
    return 0
  }
  if (task.status === 'queued') {
    return 1
  }
  return 2
}

function formatTrayFileName(fileName: string): string {
  const normalized = fileName.replace(/\s+/g, ' ').trim() || 'Unduhan tanpa nama'
  const shortened =
    normalized.length <= TRAY_FILE_NAME_LENGTH
      ? normalized
      : `${normalized.slice(0, 25)}…${normalized.slice(-(TRAY_FILE_NAME_LENGTH - 26))}`

  // Electron uses ampersands as menu mnemonic markers on Windows.
  return shortened.replace(/&/g, '&&')
}

function formatTrayTaskStatus(task: DownloadTask): string {
  const progress = Math.round(Math.min(100, Math.max(0, task.progress)))

  switch (task.status) {
    case 'downloading':
      return `Mengunduh ${progress}%`
    case 'queued':
      return 'Antrean'
    case 'paused':
      return `Dijeda ${progress}%`
    case 'completed':
      return 'Selesai'
    case 'failed':
      return 'Gagal'
    case 'cancelled':
      return 'Dibatalkan'
  }
}

function refreshTrayMenu(): void {
  if (!tray || !downloads) {
    return
  }

  const tasks = downloads
    .list()
    .sort(
      (left, right) =>
        trayTaskPriority(left) - trayTaskPriority(right) || right.updatedAt - left.updatedAt
    )
  const visibleTasks = tasks.slice(0, TRAY_DOWNLOAD_LIMIT)
  const downloadItems: MenuItemConstructorOptions[] = visibleTasks.map((task) => ({
    label: `${formatTrayFileName(task.fileName)} — ${formatTrayTaskStatus(task)}`,
    click: () => focusMainWindow()
  }))

  if (downloadItems.length === 0) {
    downloadItems.push({
      label: 'Belum ada unduhan',
      enabled: false
    })
  }

  const hiddenCount = tasks.length - visibleTasks.length
  if (hiddenCount > 0) {
    downloadItems.push({
      label: `${hiddenCount} unduhan lainnya…`,
      enabled: false
    })
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Buka Arus',
      click: () => focusMainWindow()
    },
    { type: 'separator' },
    {
      label: 'Unduhan',
      enabled: false
    },
    ...downloadItems,
    { type: 'separator' },
    {
      label: 'Keluar',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ]

  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function scheduleTrayMenuRefresh(): void {
  if (trayRefreshTimer) {
    return
  }
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null
    refreshTrayMenu()
  }, TRAY_REFRESH_INTERVAL_MS)
}

function createTray(): void {
  if (tray) {
    return
  }
  const iconPath = resolveAppIcon()
  if (!iconPath) {
    console.error('[arus] tray icon not found')
    return
  }
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Arus Download Manager')
  refreshTrayMenu()
  tray.on('double-click', () => focusMainWindow())
}

function applyLoginItemSetting(enabled: boolean): void {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ['--hidden']
  })
}

function createCaptureWindow(): void {
  if (captureWindow) {
    return
  }
  const iconPath = resolveAppIcon()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined
  captureWindow = new BrowserWindow({
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
    void captureWindow.loadURL(rendererUrl.toString())
  } else {
    void captureWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'capture' }
    })
  }

  captureWindow.webContents.on('did-finish-load', () => publishActivePending())
  captureWindow.once('ready-to-show', () => {
    if (activePendingId) {
      captureWindow?.show()
      captureWindow?.focus()
    }
  })
  captureWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      if (activePendingId) {
        pendingDownloads.remove(activePendingId)
        activePendingId = null
      }
      captureWindow?.hide()
      showNextPending()
    }
  })
  captureWindow.on('closed', () => {
    captureWindow = null
  })
}

function publishActivePending(): void {
  if (!captureWindow || captureWindow.isDestroyed()) {
    return
  }
  const pending = activePendingId
    ? pendingDownloads.list().find((item) => item.id === activePendingId) || null
    : null
  captureWindow.webContents.send('downloads:pending', pending)
}

function showNextPending(): void {
  const next = pendingDownloads.list()[0] || null
  activePendingId = next?.id || null
  if (!next) {
    publishActivePending()
    captureWindow?.hide()
    return
  }

  createCaptureWindow()
  publishActivePending()
  if (captureWindow && !captureWindow.webContents.isLoadingMainFrame()) {
    captureWindow.show()
    captureWindow.focus()
  }
}

async function revealPathInFolder(filePath: string): Promise<boolean> {
  const resolved = normalize(filePath)
  const tempPath = `${resolved}.part`
  if (existsSync(resolved)) {
    shell.showItemInFolder(resolved)
    return true
  }
  if (existsSync(tempPath)) {
    shell.showItemInFolder(tempPath)
    return true
  }
  const directory = dirname(resolved)
  if (existsSync(directory)) {
    await shell.openPath(directory)
    return true
  }
  return false
}

function maybeRevealOnComplete(task: DownloadTask): void {
  if (task.status !== 'completed') {
    return
  }
  if (!downloads.getSettings().revealOnComplete) {
    return
  }
  void revealPathInFolder(task.filePath)
}

function getBrowserIntegrationStatus(): BrowserIntegrationStatus {
  return {
    enabled: downloads.getSettings().browserIntegrationEnabled,
    bridgeListening: nativeBridge.isListening(),
    hostInstalled: Boolean(lastHostInstall?.ok),
    hostName: NATIVE_HOST_NAME,
    chromeExtensionId: lastHostInstall?.chromeExtensionId || CHROME_EXTENSION_ID,
    firefoxExtensionId: FIREFOX_EXTENSION_ID,
    extensionPath: resolveExtensionDistPath(),
    loginItemSupported: process.platform === 'win32' && app.isPackaged,
    lastError: lastHostInstall?.error
  }
}

function registerHost(): BrowserIntegrationStatus {
  lastHostInstall = installNativeMessagingHost()
  return getBrowserIntegrationStatus()
}

async function initializeApp(): Promise<void> {
  downloads = new DownloadManager(
    app.getPath('userData'),
    (task) => {
      mainWindow?.webContents.send('downloads:updated', task)
      scheduleTrayMenuRefresh()
      maybeRevealOnComplete(task)
    },
    (progress) => {
      mainWindow?.webContents.send('download:progress', progress)
      scheduleTrayMenuRefresh()
    }
  )
  pendingDownloads = new PendingDownloadManager(app.getPath('downloads'))

  nativeBridge = new NativeBridgeServer({
    isEnabled: () => downloads.getSettings().browserIntegrationEnabled,
    proposeDownload: (input) => pendingDownloads.propose(input),
    onDownloadProposed: () => showNextPending(),
    getVersion: () => app.getVersion()
  })

  registerIpcHandlers()
  createTray()
  applyLoginItemSetting(downloads.getSettings().launchAtLogin)

  if (downloads.getSettings().browserIntegrationEnabled) {
    lastHostInstall = installNativeMessagingHost()
    try {
      await nativeBridge.start()
    } catch (error) {
      console.error('[arus] native bridge failed to start:', error)
    }
  }

  if (!process.argv.includes('--hidden')) {
    focusMainWindow()
  }

  app.on('activate', () => {
    focusMainWindow()
  })
}

if (gotSingleInstanceLock) {
  void app.whenReady().then(initializeApp)
}

app.on('second-instance', (_event, argv) => {
  if (!argv.includes('--hidden') && app.isReady()) {
    focusMainWindow()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  if (trayRefreshTimer) {
    clearTimeout(trayRefreshTimer)
    trayRefreshTimer = null
  }
  tray?.destroy()
  tray = null
  void nativeBridge?.stop()
})

app.on('window-all-closed', () => {
  // Keep the main process and native bridge alive in the system tray.
})

function registerIpcHandlers(): void {
  ipcMain.handle('downloads:add', (_event, input: AddDownloadInput) =>
    downloads.add(input, app.getPath('downloads'))
  )
  ipcMain.handle('downloads:list', () => downloads.list())
  ipcMain.handle('downloads:pause', (_event, id: string) => downloads.pause(id))
  ipcMain.handle('downloads:resume', (_event, id: string) => downloads.resume(id))
  ipcMain.handle('downloads:cancel', (_event, id: string) => downloads.cancel(id))
  ipcMain.handle('downloads:remove', (_event, id: string) => {
    downloads.remove(id)
    refreshTrayMenu()
    mainWindow?.webContents.send('downloads:snapshot', downloads.list())
  })
  ipcMain.handle('downloads:pause-all', () => {
    const result = downloads.pauseAll()
    mainWindow?.webContents.send('downloads:snapshot', downloads.list())
    return result
  })
  ipcMain.handle('downloads:resume-many', (_event, ids: string[]) => {
    const result = downloads.resumeMany(ids)
    mainWindow?.webContents.send('downloads:snapshot', downloads.list())
    return result
  })
  ipcMain.handle('downloads:pause-many', (_event, ids: string[]) => {
    const result = downloads.pauseMany(ids)
    mainWindow?.webContents.send('downloads:snapshot', downloads.list())
    return result
  })
  ipcMain.handle('downloads:remove-many', (_event, ids: string[]) => {
    downloads.removeMany(ids)
    refreshTrayMenu()
    mainWindow?.webContents.send('downloads:snapshot', downloads.list())
  })
  ipcMain.handle('downloads:remove-completed', () => {
    downloads.removeCompleted()
    refreshTrayMenu()
    mainWindow?.webContents.send('downloads:snapshot', downloads.list())
  })
  ipcMain.handle('downloads:reveal-in-folder', async (_event, id: string) => {
    try {
      return await revealPathInFolder(downloads.getFilePath(id))
    } catch {
      return false
    }
  })
  ipcMain.handle('downloads:choose-directory', async (event) => {
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
  ipcMain.handle('downloads:get-settings', () => downloads.getSettings())
  ipcMain.handle('downloads:set-settings', async (_event, settings: Partial<AppSettings>) => {
    const next = downloads.setSettings(settings)
    applyLoginItemSetting(next.launchAtLogin)
    try {
      if (next.browserIntegrationEnabled) {
        lastHostInstall = installNativeMessagingHost()
        await nativeBridge.restart()
      } else {
        await nativeBridge.stop()
      }
    } catch (error) {
      console.error('[arus] native bridge restart failed:', error)
    }
    return next
  })
  ipcMain.handle('downloads:browser-integration-status', () => getBrowserIntegrationStatus())
  ipcMain.handle('downloads:install-native-host', () => registerHost())
  ipcMain.handle('downloads:open-extension-folder', async () => {
    const path = resolveExtensionDistPath()
    if (!path) {
      return null
    }
    await shell.openPath(path)
    return path
  })
  ipcMain.handle('downloads:list-pending', (event) => {
    assertCaptureSender(event)
    return pendingDownloads.list()
  })
  ipcMain.handle(
    'downloads:confirm-pending',
    (event, input: ConfirmPendingDownloadInput) => {
      assertCaptureSender(event)
      const pending = pendingDownloads.get(input.id)
      const task = downloads.add(
        {
          url: pending.url,
          directory: input.directory?.trim() || pending.directory,
          referrer: pending.referrer,
          fileName: input.fileName?.trim() || pending.fileName,
          headers: pending.headers
        },
        app.getPath('downloads')
      )
      pendingDownloads.remove(pending.id)
      activePendingId = null
      showNextPending()
      return task
    }
  )
  ipcMain.handle('downloads:reject-pending', (event, id: string) => {
    assertCaptureSender(event)
    pendingDownloads.remove(id)
    if (activePendingId === id) {
      activePendingId = null
    }
    showNextPending()
  })

  ipcMain.handle('download:start', (_event, input: AddDownloadInput) => {
    const task = downloads.add(input, app.getPath('downloads'))
    return task.id
  })
  ipcMain.handle('download:pause', (_event, id: string) => downloads.pause(id))
  ipcMain.handle('download:resume', (_event, id: string) => downloads.resume(id))
  ipcMain.handle('download:cancel', (_event, id: string) => downloads.cancel(id))

  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
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

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}

function assertCaptureSender(event: Electron.IpcMainInvokeEvent): void {
  if (!captureWindow || event.sender !== captureWindow.webContents) {
    throw new Error('Pending download actions are only available to the confirmation window')
  }
}
