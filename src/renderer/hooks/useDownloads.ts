import { useCallback, useEffect, useState } from 'react'
import type { DownloadTask } from '../../shared/downloadTypes'
import { upsertTask } from '../features/downloadList/taskHelpers'

export function useDownloads(): {
  tasks: DownloadTask[]
  refreshTasks: () => Promise<void>
  upsertLocalTask: (task: DownloadTask) => void
} {
  const [tasks, setTasks] = useState<DownloadTask[]>([])

  const refreshTasks = useCallback(async () => {
    setTasks(await window.downloads.list())
  }, [])

  const upsertLocalTask = useCallback((task: DownloadTask) => {
    setTasks((current) => upsertTask(current, task))
  }, [])

  useEffect(() => {
    void refreshTasks()

    const offUpdated = window.downloads.onUpdated((task) => {
      setTasks((current) => upsertTask(current, task))
    })
    const offSnapshot = window.downloads.onSnapshot(setTasks)
    const offProgress = window.downloads.onProgress((progress) => {
      setTasks((current) =>
        current.map((task) =>
          task.id === progress.id
            ? {
                ...task,
                bytesReceived: progress.downloadedBytes,
                totalBytes: progress.totalBytes,
                progress: progress.percent,
                speedBytesPerSecond: progress.speedBytesPerSecond,
                segments: progress.segments ?? task.segments,
                status: task.status === 'queued' ? 'downloading' : task.status
              }
            : task
        )
      )
    })

    return () => {
      offUpdated()
      offSnapshot()
      offProgress()
    }
  }, [refreshTasks])

  return { tasks, refreshTasks, upsertLocalTask }
}
