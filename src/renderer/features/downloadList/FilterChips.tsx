import type { ReactElement } from 'react'
import { motion } from 'framer-motion'
import type { DownloadFilter } from './taskHelpers'
import { spring } from '../../motion'

const FILTERS: Array<{ id: DownloadFilter; label: string }> = [
  { id: 'all', label: 'Semua' },
  { id: 'downloading', label: 'Mengunduh' },
  { id: 'completed', label: 'Selesai' },
  { id: 'paused', label: 'Dijeda' },
  { id: 'failed', label: 'Gagal' },
  { id: 'trash', label: 'Sampah' }
]

export interface FilterChipsProps {
  active: DownloadFilter
  counts: Record<DownloadFilter, number>
  onSelect: (filter: DownloadFilter) => void
}

export function FilterChips({ active, counts, onSelect }: FilterChipsProps): ReactElement {
  return (
    <div className="filter-chips" aria-label="Filter daftar unduhan">
      {FILTERS.map((filter) => {
        const selected = filter.id === active
        const count = counts[filter.id]
        return (
          <motion.button
            key={filter.id}
            type="button"
            className={`filter-chip${selected ? ' filter-chip--active' : ''}`}
            onClick={() => onSelect(filter.id)}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            transition={spring}
            aria-pressed={selected}
          >
            <span>{filter.label}</span>
            {count > 0 ? <span className="filter-chip__count mono">{count}</span> : null}
          </motion.button>
        )
      })}
    </div>
  )
}
