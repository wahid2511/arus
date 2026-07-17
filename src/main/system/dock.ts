import { app } from 'electron'
import { appState } from '../app/state'

export function syncDockVisibility(): void {
  if (process.platform !== 'darwin') {
    return
  }
  const hasVisibleWindow =
    (appState.mainWindow && !appState.mainWindow.isDestroyed() && appState.mainWindow.isVisible()) ||
    (appState.captureWindow &&
      !appState.captureWindow.isDestroyed() &&
      appState.captureWindow.isVisible())
  if (hasVisibleWindow) {
    app.dock?.show()
  } else {
    app.dock?.hide()
  }
}
