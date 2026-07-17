import { BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'
import { appState } from '../app/state'
import { syncDockVisibility } from '../system/dock'
import { resolveAppIcon } from './appIcon'

export function createMainWindow(): void {
  if (appState.mainWindow) {
    return
  }

  const iconPath = resolveAppIcon()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined

  appState.mainWindow = new BrowserWindow({
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
    void appState.mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void appState.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  appState.mainWindow.once('ready-to-show', () => {
    appState.mainWindow?.show()
    appState.mainWindow?.focus()
    syncDockVisibility()
  })
  appState.mainWindow.on('close', (event) => {
    if (!appState.isQuitting) {
      event.preventDefault()
      appState.mainWindow?.hide()
      syncDockVisibility()
    }
  })
  appState.mainWindow.on('closed', () => {
    appState.mainWindow = null
  })
}

export function focusMainWindow(): void {
  if (!appState.mainWindow) {
    createMainWindow()
  }
  if (!appState.mainWindow) {
    return
  }
  if (appState.mainWindow.isMinimized()) {
    appState.mainWindow.restore()
  }
  appState.mainWindow.show()
  appState.mainWindow.focus()
  syncDockVisibility()
}
