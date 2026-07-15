import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { DownloadManager } from './downloadManager'
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
  DownloadTask
} from '../shared/downloadTypes'

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

if (process.platform === 'win32') {
  app.setAppUserModelId('com.genghero.arus')
}

let mainWindow: BrowserWindow | null = null
let downloads: DownloadManager
let nativeBridge: NativeBridgeServer
let lastHostInstall: NativeHostInstallResult | null = null

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
    lastError: lastHostInstall?.error
  }
}

function registerHost(): BrowserIntegrationStatus {
  lastHostInstall = installNativeMessagingHost()
  return getBrowserIntegrationStatus()
}

app.whenReady().then(async () => {
  downloads = new DownloadManager(
    app.getPath('userData'),
    (task) => {
      mainWindow?.webContents.send('downloads:updated', task)
      maybeRevealOnComplete(task)
    },
    (progress) => {
      mainWindow?.webContents.send('download:progress', progress)
    }
  )

  nativeBridge = new NativeBridgeServer({
    isEnabled: () => downloads.getSettings().browserIntegrationEnabled,
    addDownload: (input) => downloads.add(input, app.getPath('downloads')),
    onDownloadAdded: () => {
      focusMainWindow()
    },
    getVersion: () => app.getVersion()
  })

  registerIpcHandlers()
  createWindow()

  if (downloads.getSettings().browserIntegrationEnabled) {
    lastHostInstall = installNativeMessagingHost()
    try {
      await nativeBridge.start()
    } catch (error) {
      console.error('[arus] native bridge failed to start:', error)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  void nativeBridge?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
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
    mainWindow?.webContents.send('downloads:snapshot', downloads.list())
  })
  ipcMain.handle('downloads:remove-completed', () => {
    downloads.removeCompleted()
    mainWindow?.webContents.send('downloads:snapshot', downloads.list())
  })
  ipcMain.handle('downloads:reveal-in-folder', async (_event, id: string) => {
    try {
      return await revealPathInFolder(downloads.getFilePath(id))
    } catch {
      return false
    }
  })
  ipcMain.handle('downloads:choose-directory', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Pilih folder unduhan',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)

    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('downloads:get-settings', () => downloads.getSettings())
  ipcMain.handle('downloads:set-settings', async (_event, settings: Partial<AppSettings>) => {
    const next = downloads.setSettings(settings)
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
