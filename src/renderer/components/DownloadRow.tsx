import type { MouseEvent, ReactElement } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { DownloadSegment, DownloadStatus } from '../../shared/downloadTypes'
import { clampPercent, formatBytes } from '../utils/format'
import { colors } from '../theme'
import {
  IconChevronDown,
  IconFolder,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconTrash
} from './Icons'

export type DownloadRowStatus = DownloadStatus

export interface DownloadRowData {
  id: string
  fileName: string
  progress: number
  status: DownloadRowStatus
  meta: string
  url?: string
  filePath?: string
  segments?: DownloadSegment[]
  speedBytesPerSecond?: number
}

export interface DownloadRowProps {
  data: DownloadRowData
  expanded: boolean
  selected: boolean
  onToggle: (id: string) => void
  onSelect: (id: string, selected: boolean) => void
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onReveal: (id: string) => void
}

const STATUS_UI: Record<
  DownloadRowStatus,
  { label: string; color: string; background: string; ring: string }
> = {
  downloading: {
    label: 'Mengunduh',
    color: colors.secondary,
    background: colors.secondaryBg,
    ring: colors.secondary
  },
  queued: {
    label: 'Antrean',
    color: colors.secondary,
    background: colors.secondaryBg,
    ring: colors.secondary
  },
  completed: {
    label: 'Selesai',
    color: colors.success,
    background: colors.successBg,
    ring: colors.success
  },
  paused: {
    label: 'Dijeda',
    color: colors.textSecondary,
    background: colors.border,
    ring: colors.textSecondary
  },
  failed: {
    label: 'Gagal',
    color: colors.error,
    background: colors.errorBg,
    ring: colors.error
  },
  cancelled: {
    label: 'Sampah',
    color: colors.textSecondary,
    background: colors.border,
    ring: colors.textSecondary
  }
}

const RING_RADIUS = 15
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const spring = { type: 'spring' as const, stiffness: 380, damping: 30, mass: 0.65 }

function ProgressRing({
  progress,
  status,
  prominent
}: {
  progress: number
  status: DownloadRowStatus
  prominent: boolean
}): ReactElement {
  const ui = STATUS_UI[status]
  const pct = clampPercent(progress)
  const filled = (pct / 100) * RING_CIRCUMFERENCE
  const size = prominent ? 40 : 32
  const center = size / 2

  if (status === 'completed') {
    return (
      <svg className="progress-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={center} cy={center} r={RING_RADIUS} fill="none" stroke={ui.ring} strokeWidth="3" />
      </svg>
    )
  }

  return (
    <svg className="progress-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={center} cy={center} r={RING_RADIUS} fill="none" stroke="var(--color-border)" strokeWidth="3" />
      <motion.circle
        cx={center}
        cy={center}
        r={RING_RADIUS}
        fill="none"
        stroke={ui.ring}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${RING_CIRCUMFERENCE - filled}`}
        transform={`rotate(-90 ${center} ${center})`}
        animate={
          status === 'downloading'
            ? { opacity: [1, 0.55, 1] }
            : { opacity: 1 }
        }
        transition={
          status === 'downloading'
            ? { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
            : undefined
        }
      />
    </svg>
  )
}

function segmentPercent(segment: DownloadSegment): number {
  const total = segment.end - segment.start + 1
  if (total <= 0) {
    return 0
  }
  return clampPercent((segment.downloaded / total) * 100)
}

function segmentLabel(segment: DownloadSegment): string {
  const pct = segmentPercent(segment)
  if (pct >= 100) {
    return 'Selesai'
  }
  if (segment.downloaded <= 0) {
    return 'Menunggu'
  }
  return 'Aktif'
}

export default function DownloadRow({
  data,
  expanded,
  selected,
  onToggle,
  onSelect,
  onPause,
  onResume,
  onCancel,
  onRemove,
  onReveal
}: DownloadRowProps): ReactElement {
  const ui = STATUS_UI[data.status]
  const isActive = data.status === 'downloading'
  const isMuted = data.status === 'cancelled'
  const hasSegments = Boolean(data.segments && data.segments.length > 0)
  const canPause = data.status === 'downloading' || data.status === 'queued'
  const canResume =
    data.status === 'paused' || data.status === 'failed' || data.status === 'cancelled'
  const canCancel =
    data.status === 'downloading' || data.status === 'queued' || data.status === 'paused'
  const canRemove =
    data.status === 'completed' ||
    data.status === 'failed' ||
    data.status === 'cancelled' ||
    data.status === 'paused'

  function stopPropagation(event: MouseEvent): void {
    event.stopPropagation()
  }

  return (
    <motion.article
      layout
      className={[
        'download-row',
        isActive ? 'download-row--active' : '',
        isMuted ? 'download-row--muted' : '',
        selected ? 'download-row--selected' : '',
        expanded ? 'download-row--expanded' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={spring}
    >
      {isActive ? <span className="download-row__pulse" /> : null}

      <div
        className="download-row__main"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => onToggle(data.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle(data.id)
          }
        }}
      >
        <label className="download-row__check" onClick={stopPropagation}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect(data.id, event.target.checked)}
            aria-label={`Pilih ${data.fileName}`}
          />
        </label>

        <ProgressRing progress={data.progress} status={data.status} prominent={isActive} />

        <div className="download-row__body">
          <div className="download-row__name">{data.fileName}</div>
          <div className="download-row__meta mono">{data.meta}</div>
        </div>

        <span
          className="download-row__badge"
          style={{ color: ui.color, backgroundColor: ui.background }}
        >
          {ui.label}
        </span>

        <div className="download-row__actions" onClick={stopPropagation}>
          {canPause ? (
            <motion.button
              type="button"
              className="row-action"
              aria-label="Jeda"
              title="Jeda"
              onClick={() => onPause(data.id)}
              whileTap={{ scale: 0.9 }}
            >
              <IconPlayerPause size={14} />
            </motion.button>
          ) : null}

          {canResume ? (
            <motion.button
              type="button"
              className="row-action row-action--accent"
              aria-label="Lanjut"
              title="Lanjut"
              onClick={() => onResume(data.id)}
              whileTap={{ scale: 0.9 }}
            >
              <IconPlayerPlay size={14} />
            </motion.button>
          ) : null}

          <motion.button
            type="button"
            className={
              data.status === 'completed' ? 'row-action row-action--accent' : 'row-action'
            }
            aria-label="Tampilkan di folder"
            title="Tampilkan di folder"
            onClick={() => onReveal(data.id)}
            whileTap={{ scale: 0.9 }}
          >
            <IconFolder size={14} />
          </motion.button>

          {canCancel ? (
            <motion.button
              type="button"
              className="row-action row-action--danger"
              aria-label="Stop"
              title="Stop"
              onClick={() => onCancel(data.id)}
              whileTap={{ scale: 0.9 }}
            >
              <IconPlayerStop size={13} />
            </motion.button>
          ) : null}

          {canRemove && !canCancel ? (
            <motion.button
              type="button"
              className="row-action row-action--danger"
              aria-label="Hapus"
              title="Hapus"
              onClick={() => onRemove(data.id)}
              whileTap={{ scale: 0.9 }}
            >
              <IconTrash size={14} />
            </motion.button>
          ) : null}

          <motion.button
            type="button"
            className="row-action row-action--chevron"
            aria-label={expanded ? 'Sembunyikan detail' : 'Tampilkan detail'}
            onClick={() => onToggle(data.id)}
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={spring}
          >
            <IconChevronDown size={14} />
          </motion.button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            className="download-row__details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring}
          >
            <div className="download-row__details-inner">
              <div className="download-detail-grid">
                <div className="download-detail">
                  <span className="download-detail__label">URL</span>
                  <span className="download-detail__value" title={data.url}>
                    {data.url || '—'}
                  </span>
                </div>
                <div className="download-detail">
                  <span className="download-detail__label">Lokasi</span>
                  <span className="download-detail__value" title={data.filePath}>
                    {data.filePath || '—'}
                  </span>
                </div>
                <div className="download-detail">
                  <span className="download-detail__label">Progress</span>
                  <span className="download-detail__value mono">
                    {data.progress.toFixed(1)}%
                    {hasSegments ? ` · ${data.segments!.length} koneksi` : ' · 1 koneksi'}
                  </span>
                </div>
              </div>

              {hasSegments ? (
                <div className="segment-list" aria-label="Segmen paralel">
                  <div className="segment-list__header">Unduhan paralel</div>
                  {data.segments!.map((segment, index) => {
                    const pct = segmentPercent(segment)
                    const total = segment.end - segment.start + 1
                    return (
                      <motion.div
                        key={segment.index}
                        className="segment-row"
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.03, ...spring }}
                      >
                        <span className="segment-row__index mono">#{segment.index + 1}</span>
                        <div className="segment-row__track">
                          <motion.div
                            className="segment-row__fill"
                            animate={{ width: `${pct}%` }}
                            transition={spring}
                            style={{
                              background:
                                pct >= 100 ? 'var(--color-success)' : 'var(--color-secondary)'
                            }}
                          />
                        </div>
                        <span className="segment-row__stats mono">
                          {formatBytes(segment.downloaded)} / {formatBytes(total)}
                        </span>
                        <span className="segment-row__status">{segmentLabel(segment)}</span>
                      </motion.div>
                    )
                  })}
                </div>
              ) : (
                <p className="download-row__empty-segments">
                  Unduhan single-connection — tidak ada segmen paralel.
                </p>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.article>
  )
}
