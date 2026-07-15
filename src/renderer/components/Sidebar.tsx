import { useState } from 'react'
import type { ComponentType, ReactElement } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  IconAlertTriangle,
  IconArrowDownCircle,
  IconCheck,
  IconLayoutGrid,
  IconPlayerPause,
  IconTrash
} from './Icons'

export type SidebarFilter = 'all' | 'downloading' | 'completed' | 'paused' | 'failed' | 'trash'

export interface SidebarItem {
  id: SidebarFilter
  label: string
  icon: ComponentType<{ size?: number }>
}

export const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: 'all', label: 'Semua', icon: IconLayoutGrid },
  { id: 'downloading', label: 'Mengunduh', icon: IconArrowDownCircle },
  { id: 'completed', label: 'Selesai', icon: IconCheck },
  { id: 'paused', label: 'Dijeda', icon: IconPlayerPause },
  { id: 'failed', label: 'Gagal', icon: IconAlertTriangle },
  { id: 'trash', label: 'Sampah', icon: IconTrash }
]

export interface SidebarProps {
  active: SidebarFilter
  onSelect: (id: SidebarFilter) => void
  counts?: Partial<Record<SidebarFilter, number>>
}

const spring = { type: 'spring' as const, stiffness: 420, damping: 32, mass: 0.7 }

export default function Sidebar({ active, onSelect, counts }: SidebarProps): ReactElement {
  const [hovered, setHovered] = useState(false)

  return (
    <motion.nav
      className={`nav-rail${hovered ? ' nav-rail--open' : ''}`}
      aria-label="Filter unduhan"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      animate={{ width: hovered ? 168 : 64 }}
      transition={spring}
    >
      <div className="nav-rail__inner">
        {SIDEBAR_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = item.id === active
          const count = counts?.[item.id]

          return (
            <motion.button
              key={item.id}
              type="button"
              className={`nav-rail__item${isActive ? ' nav-rail__item--active' : ''}`}
              onClick={() => onSelect(item.id)}
              aria-current={isActive ? 'page' : undefined}
              title={item.label}
              whileHover={{ x: 2 }}
              whileTap={{ scale: 0.96 }}
              transition={spring}
            >
              {isActive ? (
                <motion.span
                  className="nav-rail__pill"
                  layoutId="nav-active-pill"
                  transition={spring}
                />
              ) : null}
              <span className="nav-rail__icon">
                <Icon size={17} />
              </span>
              <AnimatePresence initial={false}>
                {hovered ? (
                  <motion.span
                    className="nav-rail__label"
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -6 }}
                    transition={{ duration: 0.16 }}
                  >
                    {item.label}
                  </motion.span>
                ) : null}
              </AnimatePresence>
              {typeof count === 'number' && count > 0 ? (
                <span className={`nav-rail__count mono${hovered ? '' : ' nav-rail__count--dot'}`}>
                  {hovered ? count : ''}
                </span>
              ) : null}
            </motion.button>
          )
        })}
      </div>
    </motion.nav>
  )
}
