import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENTS } from '../shared/ipcChannels'
import type {
  AddDownloadInput,
  AppSettings,
  BrowserIntegrationStatus,
  ConfirmPendingDownloadInput,
  DownloadProgressEvent,
  DownloadTask,
  DownloadsApi,
  NetworkEndpointInfo,
  PendingDownload,
  SpeedTestApi,
  SpeedTestProgress
} from '../shared/downloadTypes'

const downloadsApi: DownloadsApi = {
  add: (input: AddDownloadInput) => ipcRenderer.invoke(IPC.downloads.add, input),
  list: () => ipcRenderer.invoke(IPC.downloads.list),
  pause: (id: string) => ipcRenderer.invoke(IPC.downloads.pause, id),
  resume: (id: string) => ipcRenderer.invoke(IPC.downloads.resume, id),
  cancel: (id: string) => ipcRenderer.invoke(IPC.downloads.cancel, id),
  remove: (id: string) => ipcRenderer.invoke(IPC.downloads.remove, id),
  pauseAll: () => ipcRenderer.invoke(IPC.downloads.pauseAll),
  resumeMany: (ids: string[]) => ipcRenderer.invoke(IPC.downloads.resumeMany, ids),
  pauseMany: (ids: string[]) => ipcRenderer.invoke(IPC.downloads.pauseMany, ids),
  removeMany: (ids: string[]) => ipcRenderer.invoke(IPC.downloads.removeMany, ids),
  removeCompleted: () => ipcRenderer.invoke(IPC.downloads.removeCompleted),
  revealInFolder: (id: string) => ipcRenderer.invoke(IPC.downloads.revealInFolder, id),
  chooseDirectory: () => ipcRenderer.invoke(IPC.downloads.chooseDirectory),
  getSettings: () => ipcRenderer.invoke(IPC.downloads.getSettings),
  setSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC.downloads.setSettings, settings),
  getBrowserIntegrationStatus: () =>
    ipcRenderer.invoke(IPC.downloads.browserIntegrationStatus) as Promise<BrowserIntegrationStatus>,
  installNativeHost: () =>
    ipcRenderer.invoke(IPC.downloads.installNativeHost) as Promise<BrowserIntegrationStatus>,
  openExtensionFolder: () =>
    ipcRenderer.invoke(IPC.downloads.openExtensionFolder) as Promise<string | null>,
  listPending: () => ipcRenderer.invoke(IPC.downloads.listPending) as Promise<PendingDownload[]>,
  confirmPending: (input: ConfirmPendingDownloadInput) =>
    ipcRenderer.invoke(IPC.downloads.confirmPending, input) as Promise<DownloadTask>,
  rejectPending: (id: string) => ipcRenderer.invoke(IPC.downloads.rejectPending, id),
  onPending: (callback: (pending: PendingDownload | null) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      pending: PendingDownload | null
    ): void => callback(pending)
    ipcRenderer.on(IPC_EVENTS.downloadsPending, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.downloadsPending, listener)
  },
  onUpdated: (callback: (task: DownloadTask) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, task: DownloadTask): void => callback(task)
    ipcRenderer.on(IPC_EVENTS.downloadsUpdated, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.downloadsUpdated, listener)
  },
  onSnapshot: (callback: (tasks: DownloadTask[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tasks: DownloadTask[]): void =>
      callback(tasks)
    ipcRenderer.on(IPC_EVENTS.downloadsSnapshot, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.downloadsSnapshot, listener)
  },
  onProgress: (callback: (progress: DownloadProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: DownloadProgressEvent): void =>
      callback(progress)
    ipcRenderer.on(IPC_EVENTS.downloadProgress, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.downloadProgress, listener)
  }
}

const windowControlsApi = {
  minimize: () => ipcRenderer.send(IPC.window.minimize),
  maximize: () => ipcRenderer.send(IPC.window.maximize),
  close: () => ipcRenderer.send(IPC.window.close)
}

const speedTestApi: SpeedTestApi = {
  start: () => ipcRenderer.invoke(IPC.speedTest.start),
  cancel: () => ipcRenderer.invoke(IPC.speedTest.cancel),
  getNetworkInfo: () =>
    ipcRenderer.invoke(IPC.speedTest.networkInfo) as Promise<NetworkEndpointInfo>,
  onProgress: (callback: (progress: SpeedTestProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SpeedTestProgress): void =>
      callback(progress)
    ipcRenderer.on(IPC_EVENTS.speedTestProgress, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.speedTestProgress, listener)
  }
}

contextBridge.exposeInMainWorld('downloads', downloadsApi)
contextBridge.exposeInMainWorld('speedTest', speedTestApi)
contextBridge.exposeInMainWorld('windowControls', windowControlsApi)
