import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddDownloadInput,
  AppSettings,
  BrowserIntegrationStatus,
  DownloadProgressEvent,
  DownloadTask,
  DownloadsApi
} from '../shared/downloadTypes'

const downloadsApi: DownloadsApi = {
  add: (input: AddDownloadInput) => ipcRenderer.invoke('downloads:add', input),
  list: () => ipcRenderer.invoke('downloads:list'),
  pause: (id: string) => ipcRenderer.invoke('downloads:pause', id),
  resume: (id: string) => ipcRenderer.invoke('downloads:resume', id),
  cancel: (id: string) => ipcRenderer.invoke('downloads:cancel', id),
  remove: (id: string) => ipcRenderer.invoke('downloads:remove', id),
  pauseAll: () => ipcRenderer.invoke('downloads:pause-all'),
  resumeMany: (ids: string[]) => ipcRenderer.invoke('downloads:resume-many', ids),
  pauseMany: (ids: string[]) => ipcRenderer.invoke('downloads:pause-many', ids),
  removeMany: (ids: string[]) => ipcRenderer.invoke('downloads:remove-many', ids),
  removeCompleted: () => ipcRenderer.invoke('downloads:remove-completed'),
  revealInFolder: (id: string) => ipcRenderer.invoke('downloads:reveal-in-folder', id),
  chooseDirectory: () => ipcRenderer.invoke('downloads:choose-directory'),
  getSettings: () => ipcRenderer.invoke('downloads:get-settings'),
  setSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke('downloads:set-settings', settings),
  getBrowserIntegrationStatus: () =>
    ipcRenderer.invoke('downloads:browser-integration-status') as Promise<BrowserIntegrationStatus>,
  installNativeHost: () =>
    ipcRenderer.invoke('downloads:install-native-host') as Promise<BrowserIntegrationStatus>,
  openExtensionFolder: () =>
    ipcRenderer.invoke('downloads:open-extension-folder') as Promise<string | null>,
  onUpdated: (callback: (task: DownloadTask) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, task: DownloadTask): void => callback(task)
    ipcRenderer.on('downloads:updated', listener)
    return () => ipcRenderer.removeListener('downloads:updated', listener)
  },
  onSnapshot: (callback: (tasks: DownloadTask[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tasks: DownloadTask[]): void =>
      callback(tasks)
    ipcRenderer.on('downloads:snapshot', listener)
    return () => ipcRenderer.removeListener('downloads:snapshot', listener)
  },
  onProgress: (callback: (progress: DownloadProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: DownloadProgressEvent): void =>
      callback(progress)
    ipcRenderer.on('download:progress', listener)
    return () => ipcRenderer.removeListener('download:progress', listener)
  }
}

const windowControlsApi = {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close')
}

contextBridge.exposeInMainWorld('downloads', downloadsApi)
contextBridge.exposeInMainWorld('windowControls', windowControlsApi)
