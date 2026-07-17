import { app, Menu, nativeImage, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { DownloadTask } from '../../shared/downloadTypes'
import { appState } from '../app/state'
import { focusMainWindow } from '../windows/mainWindow'
import { resolveAppIcon } from '../windows/appIcon'

const TRAY_DOWNLOAD_LIMIT = 8
const TRAY_REFRESH_INTERVAL_MS = 500
const TRAY_FILE_NAME_LENGTH = 42

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

  return process.platform === 'win32' ? shortened.replace(/&/g, '&&') : shortened
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

export function refreshTrayMenu(): void {
  if (!appState.tray || !appState.downloads) {
    return
  }

  const tasks = appState.downloads
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
        appState.isQuitting = true
        app.quit()
      }
    }
  ]

  appState.tray.setContextMenu(Menu.buildFromTemplate(template))
}

export function scheduleTrayMenuRefresh(): void {
  if (appState.trayRefreshTimer) {
    return
  }
  appState.trayRefreshTimer = setTimeout(() => {
    appState.trayRefreshTimer = null
    refreshTrayMenu()
  }, TRAY_REFRESH_INTERVAL_MS)
}

export function createTray(): void {
  if (appState.tray) {
    return
  }
  const iconPath = resolveAppIcon()
  if (!iconPath) {
    console.error('[arus] tray icon not found')
    return
  }
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  }
  appState.tray = new Tray(icon)
  appState.tray.setToolTip('Arus Download Manager')
  refreshTrayMenu()
  if (process.platform === 'darwin') {
    appState.tray.on('click', () => focusMainWindow())
  } else {
    appState.tray.on('double-click', () => focusMainWindow())
  }
}

export function destroyTray(): void {
  if (appState.trayRefreshTimer) {
    clearTimeout(appState.trayRefreshTimer)
    appState.trayRefreshTimer = null
  }
  appState.tray?.destroy()
  appState.tray = null
}
