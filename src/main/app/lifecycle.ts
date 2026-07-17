import { app } from 'electron'
import { appState } from './state'
import { destroyTray } from '../tray/trayController'
import { focusMainWindow } from '../windows/mainWindow'

export function registerLifecycleHandlers(): void {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--hidden') && app.isReady()) {
      focusMainWindow()
    }
  })

  app.on('before-quit', () => {
    appState.isQuitting = true
    destroyTray()
    void appState.nativeBridge?.stop()
  })

  app.on('window-all-closed', () => {
    // Keep the main process and native bridge alive in the system tray.
  })
}
