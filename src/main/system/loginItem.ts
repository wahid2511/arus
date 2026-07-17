import { app } from 'electron'

export function isLoginItemSupported(): boolean {
  return (process.platform === 'win32' || process.platform === 'darwin') && app.isPackaged
}

export function shouldStartHidden(): boolean {
  if (process.argv.includes('--hidden')) {
    return true
  }
  if (process.platform === 'darwin' && app.isPackaged) {
    return app.getLoginItemSettings().wasOpenedAsHidden
  }
  return false
}

export function applyLoginItemSetting(enabled: boolean): void {
  if (!isLoginItemSupported()) {
    return
  }
  if (process.platform === 'win32') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: ['--hidden']
    })
    return
  }
  if (process.platform === 'darwin') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled
    })
  }
}
