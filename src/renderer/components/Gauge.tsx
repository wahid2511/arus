import { useEffect, type ReactElement } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'
import { clampPercent } from '../utils/format'

export interface GaugeProps {
  percentage: number
  value: string
  unit?: string
  ariaLabel?: string
  width?: number
  height?: number
  alive?: boolean
}

const CX = 110
const CY = 108
const RADIUS = 78
const STROKE = 11
const TIP_RADIUS = 7
const springConfig = { stiffness: 110, damping: 16, mass: 0.55 }

function polar(radius: number, percent: number): { x: number; y: number } {
  const angle = Math.PI * (1 - clampPercent(percent) / 100)
  return {
    x: CX + radius * Math.cos(angle),
    y: CY - radius * Math.sin(angle)
  }
}

export default function Gauge({
  percentage,
  value,
  unit = 'MB/s',
  ariaLabel,
  width = 248,
  height = 168,
  alive = false
}: GaugeProps): ReactElement {
  const springPct = useSpring(clampPercent(percentage), springConfig)

  useEffect(() => {
    springPct.set(clampPercent(percentage))
  }, [percentage, springPct])

  const tipX = useTransform(springPct, (v) => polar(RADIUS, v).x)
  const tipY = useTransform(springPct, (v) => polar(RADIUS, v).y)
  const pathLength = useTransform(springPct, (v) => clampPercent(v) / 100)

  return (
    <motion.div
      className={`gauge-shell${alive ? ' gauge-shell--alive' : ''}`}
      animate={alive ? { y: [0, -3, 0] } : { y: 0 }}
      transition={
        alive
          ? { duration: 3.2, repeat: Infinity, ease: 'easeInOut' }
          : { type: 'spring', stiffness: 200, damping: 24 }
      }
    >
      <svg
        className="gauge"
        viewBox="0 0 220 168"
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel ?? `Kecepatan unduh ${value} ${unit}`}
      >
        <path
          d={`M${CX - RADIUS},${CY} A${RADIUS},${RADIUS} 0 0 1 ${CX + RADIUS},${CY} L${CX},${CY} Z`}
          fill="var(--color-panel)"
          opacity="0.7"
        />

        <path
          d={`M${CX - RADIUS},${CY} A${RADIUS},${RADIUS} 0 0 1 ${CX + RADIUS},${CY}`}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />

        <motion.path
          d={`M${CX - RADIUS},${CY} A${RADIUS},${RADIUS} 0 0 1 ${CX + RADIUS},${CY}`}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          style={{ pathLength }}
        />

        <motion.circle
          cx={tipX}
          cy={tipY}
          r={TIP_RADIUS}
          fill="var(--color-primary)"
          stroke="var(--color-bg)"
          strokeWidth="3"
        />
      </svg>

      <div className="gauge-readout">
        <motion.div
          className="gauge-readout__value mono"
          key={value}
          initial={{ opacity: 0.4, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        >
          {value}
        </motion.div>
        <div className="gauge-readout__unit mono">{unit}</div>
      </div>
    </motion.div>
  )
}
