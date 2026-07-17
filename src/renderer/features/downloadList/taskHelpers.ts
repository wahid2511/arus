import type { DownloadTask } from '../../../shared/downloadTypes'
import type { DownloadRowData } from '../../components/DownloadRow'
import { formatBytes, formatEta, formatSpeed } from '../../utils/format'

export type DownloadFilter = 'all' | 'downloading' | 'completed' | 'paused' | 'failed' | 'trash'

export function taskSortWeight(task: DownloadTask): number {
  switch (task.status) {
    case 'downloading':
      return 50
    case 'queued':
      return 40
    case 'paused':
      return 30
    case 'failed':
      return 20
    case 'completed':
      return 10
    default:
      return 0
  }
}

export function upsertTask(tasks: DownloadTask[], updated: DownloadTask): DownloadTask[] {
  const exists = tasks.some((task) => task.id === updated.id)
  const next = exists
    ? tasks.map((task) => (task.id === updated.id ? updated : task))
    : [updated, ...tasks]
  return next.sort((a, b) => b.createdAt - a.createdAt)
}

export function filterTasks(tasks: DownloadTask[], filter: DownloadFilter): DownloadTask[] {
  const sorted = [...tasks].sort(
    (a, b) => taskSortWeight(b) - taskSortWeight(a) || b.createdAt - a.createdAt
  )

  switch (filter) {
    case 'downloading':
      return sorted.filter((task) => task.status === 'downloading' || task.status === 'queued')
    case 'completed':
      return sorted.filter((task) => task.status === 'completed')
    case 'paused':
      return sorted.filter((task) => task.status === 'paused')
    case 'failed':
      return sorted.filter((task) => task.status === 'failed')
    case 'trash':
      return sorted.filter((task) => task.status === 'cancelled')
    default:
      return sorted.filter((task) => task.status !== 'cancelled')
  }
}

export function toDownloadRow(task: DownloadTask): DownloadRowData {
  return {
    id: task.id,
    fileName: task.fileName,
    progress: task.progress,
    status: task.status,
    meta: buildMeta(task),
    url: task.url,
    filePath: task.filePath,
    segments: task.segments,
    speedBytesPerSecond: task.speedBytesPerSecond
  }
}

function buildMeta(task: DownloadTask): string {
  const received = formatBytes(task.bytesReceived)
  const total = task.totalBytes ? formatBytes(task.totalBytes) : '?'

  if (task.status === 'completed') {
    const time = new Date(task.updatedAt).toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit'
    })
    return `${total} selesai · ${time}`
  }

  if (task.status === 'paused') {
    return `${received} / ${total} · dijeda`
  }

  if (task.status === 'failed') {
    return task.error ? `${received} / ${total} · ${task.error}` : `${received} / ${total} · gagal`
  }

  if (task.status === 'cancelled') {
    return `${received} / ${total} · dibatalkan`
  }

  if (task.status === 'queued') {
    return `${received} / ${total} · antrean`
  }

  const remaining = task.totalBytes ? Math.max(0, task.totalBytes - task.bytesReceived) : 0
  const eta = formatEta(remaining, task.speedBytesPerSecond)
  return `${received} / ${total} · ${formatSpeed(task.speedBytesPerSecond)} · ${eta}`
}

export function countTasksByFilter(tasks: DownloadTask[]): Record<DownloadFilter, number> {
  return {
    all: tasks.filter((task) => task.status !== 'cancelled').length,
    downloading: tasks.filter((task) => task.status === 'downloading' || task.status === 'queued')
      .length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    paused: tasks.filter((task) => task.status === 'paused').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    trash: tasks.filter((task) => task.status === 'cancelled').length
  }
}
