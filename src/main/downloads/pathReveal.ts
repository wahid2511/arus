import { existsSync } from 'node:fs'
import { dirname, normalize } from 'node:path'
import { shell } from 'electron'
import type { DownloadTask } from '../../shared/downloadTypes'
import { appState } from '../app/state'

export async function revealPathInFolder(filePath: string): Promise<boolean> {
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

export function maybeRevealOnComplete(task: DownloadTask): void {
  if (task.status !== 'completed') {
    return
  }
  if (!appState.downloads?.getSettings().revealOnComplete) {
    return
  }
  void revealPathInFolder(task.filePath)
}
