import { app } from 'electron'
import { createApp } from './app/createApp'
import { registerLifecycleHandlers } from './app/lifecycle'

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

if (process.platform === 'win32') {
  app.setAppUserModelId('com.genghero.arus')
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  registerLifecycleHandlers()
  void app.whenReady().then(createApp)
}
