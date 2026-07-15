export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toFixed(index === 0 ? 0 : fractionDigits)} ${units[index]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

export function splitSpeed(bytesPerSecond: number): { value: string; unit: string } {
  const formatted = formatSpeed(bytesPerSecond)
  const [value, unit] = formatted.split(' ')
  return { value, unit: unit ?? 'B/s' }
}

export function formatEta(bytesRemaining: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0 || bytesRemaining <= 0) {
    return '—'
  }

  const totalSeconds = Math.ceil(bytesRemaining / bytesPerSecond)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
  }

  return `${seconds}s`
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(100, Math.max(0, value))
}
