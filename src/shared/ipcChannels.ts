/** IPC invoke channels (main ↔ preload). */
export const IPC = {
  downloads: {
    add: 'downloads:add',
    list: 'downloads:list',
    pause: 'downloads:pause',
    resume: 'downloads:resume',
    cancel: 'downloads:cancel',
    remove: 'downloads:remove',
    pauseAll: 'downloads:pause-all',
    resumeMany: 'downloads:resume-many',
    pauseMany: 'downloads:pause-many',
    removeMany: 'downloads:remove-many',
    removeCompleted: 'downloads:remove-completed',
    revealInFolder: 'downloads:reveal-in-folder',
    chooseDirectory: 'downloads:choose-directory',
    getSettings: 'downloads:get-settings',
    setSettings: 'downloads:set-settings',
    browserIntegrationStatus: 'downloads:browser-integration-status',
    installNativeHost: 'downloads:install-native-host',
    openExtensionFolder: 'downloads:open-extension-folder',
    listPending: 'downloads:list-pending',
    confirmPending: 'downloads:confirm-pending',
    rejectPending: 'downloads:reject-pending'
  },
  window: {
    minimize: 'window:minimize',
    maximize: 'window:maximize',
    close: 'window:close'
  }
} as const

/** IPC push events (main → renderer). */
export const IPC_EVENTS = {
  downloadsUpdated: 'downloads:updated',
  downloadsSnapshot: 'downloads:snapshot',
  downloadsPending: 'downloads:pending',
  downloadProgress: 'download:progress'
} as const
