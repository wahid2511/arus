import type { ReactElement, ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  IconClearCompleted,
  IconFolder,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconSelectAll,
  IconTrash
} from './Icons'

export interface ActionToolbarProps {
  selectedCount: number
  visibleCount: number
  hasActive: boolean
  hasCompleted: boolean
  canResumeSelected: boolean
  canPauseSelected: boolean
  canRemoveSelected: boolean
  canRevealSelected: boolean
  allVisibleSelected: boolean
  onToggleSelectAll: () => void
  onStopAll: () => void
  onResumeSelected: () => void
  onPauseSelected: () => void
  onRemoveSelected: () => void
  onRemoveCompleted: () => void
  onRevealSelected: () => void
}

const spring = { type: 'spring' as const, stiffness: 420, damping: 32 }

export default function ActionToolbar({
  selectedCount,
  visibleCount,
  hasActive,
  hasCompleted,
  canResumeSelected,
  canPauseSelected,
  canRemoveSelected,
  canRevealSelected,
  allVisibleSelected,
  onToggleSelectAll,
  onStopAll,
  onResumeSelected,
  onPauseSelected,
  onRemoveSelected,
  onRemoveCompleted,
  onRevealSelected
}: ActionToolbarProps): ReactElement {
  return (
    <div className="action-toolbar" role="toolbar" aria-label="Aksi unduhan">
      <div className="action-toolbar__group">
        <ToolbarButton
          label={allVisibleSelected ? 'Batal pilih' : 'Pilih semua'}
          onClick={onToggleSelectAll}
          disabled={visibleCount === 0}
        >
          <IconSelectAll size={15} />
        </ToolbarButton>
        <ToolbarButton label="Stop semua" onClick={onStopAll} disabled={!hasActive} tone="warn">
          <IconPlayerStop size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Hapus selesai"
          onClick={onRemoveCompleted}
          disabled={!hasCompleted}
          tone="danger"
        >
          <IconClearCompleted size={15} />
        </ToolbarButton>
      </div>

      <div className="action-toolbar__divider" />

      <div className="action-toolbar__group">
        <span className="action-toolbar__count mono">
          {selectedCount > 0 ? `${selectedCount} dipilih` : 'Tidak ada dipilih'}
        </span>
        <ToolbarButton
          label="Lanjut dipilih"
          onClick={onResumeSelected}
          disabled={!canResumeSelected}
          tone="accent"
        >
          <IconPlayerPlay size={14} />
        </ToolbarButton>
        <ToolbarButton label="Jeda dipilih" onClick={onPauseSelected} disabled={!canPauseSelected}>
          <IconPlayerPause size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Buka folder"
          onClick={onRevealSelected}
          disabled={!canRevealSelected}
        >
          <IconFolder size={15} />
        </ToolbarButton>
        <ToolbarButton
          label="Hapus dipilih"
          onClick={onRemoveSelected}
          disabled={!canRemoveSelected}
          tone="danger"
        >
          <IconTrash size={14} />
        </ToolbarButton>
      </div>
    </div>
  )
}

function ToolbarButton({
  children,
  label,
  onClick,
  disabled,
  tone
}: {
  children: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  tone?: 'accent' | 'danger' | 'warn'
}): ReactElement {
  return (
    <motion.button
      type="button"
      className={`toolbar-btn${tone ? ` toolbar-btn--${tone}` : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      transition={spring}
    >
      {children}
      <span>{label}</span>
    </motion.button>
  )
}
