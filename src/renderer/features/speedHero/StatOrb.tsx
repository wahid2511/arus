import type { ReactElement } from 'react'
import { motion } from 'framer-motion'
import { spring } from '../../motion'

export function StatOrb({
  label,
  value,
  accent,
  wide
}: {
  label: string
  value: string
  accent?: 'teal'
  wide?: boolean
}): ReactElement {
  return (
    <motion.div
      className={`stat-orb${wide ? ' stat-orb--wide' : ''}${accent === 'teal' ? ' stat-orb--teal' : ''}`}
      layout
      transition={spring}
    >
      <div className="stat-orb__label">{label}</div>
      <div className="stat-orb__value mono">{value}</div>
    </motion.div>
  )
}
