import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type {
  NetworkEndpointInfo,
  SpeedTestProgress,
  SpeedTestResult
} from '../../../shared/downloadTypes'
import Gauge from '../../components/Gauge'
import { IconPlayerPlay, IconPlayerStop } from '../../components/Icons'
import { spring } from '../../motion'

const SPEEDTEST_GAUGE_MAX_MBPS = 1000

const INITIAL_PROGRESS: SpeedTestProgress = {
  phase: 'idle',
  progress: 0,
  message: 'Siap menguji koneksi internet',
  server: 'Cloudflare'
}

export function SpeedTestView(): ReactElement {
  const [progress, setProgress] = useState<SpeedTestProgress>(INITIAL_PROGRESS)
  const [result, setResult] = useState<SpeedTestResult | null>(null)
  const [running, setRunning] = useState(false)
  const [network, setNetwork] = useState<NetworkEndpointInfo | null>(null)

  useEffect(() => {
    void window.speedTest.getNetworkInfo().then(setNetwork).catch(() => {
      setNetwork({ localIp: null, publicIp: null })
    })

    return window.speedTest.onProgress((next) => {
      setProgress(next)
      if (next.localIp || next.publicIp || next.interfaceName || next.colo) {
        setNetwork({
          localIp: next.localIp ?? null,
          publicIp: next.publicIp ?? null,
          interfaceName: next.interfaceName ?? null,
          colo: next.colo ?? null,
          location: next.colo ? `Cloudflare ${next.colo}` : null
        })
      }
      if (next.phase === 'complete' || next.phase === 'error' || next.phase === 'cancelled') {
        setRunning(false)
      }
    })
  }, [])

  const mainMetric = useMemo(() => {
    if (progress.phase === 'latency') {
      return {
        value: progress.latencyMs ? String(Math.round(progress.latencyMs)) : '--',
        unit: 'ms',
        label: 'Latency'
      }
    }
    if (progress.phase === 'upload') {
      const value = progress.currentMbps ?? progress.uploadMbps
      return { value: formatMbpsValue(value), unit: 'Mbps', label: 'Upload' }
    }
    const value = progress.currentMbps ?? progress.downloadMbps
    return { value: formatMbpsValue(value), unit: 'Mbps', label: 'Download' }
  }, [progress])

  const gaugePercent = Math.min(
    100,
    progress.phase === 'latency'
      ? progress.progress * 100
      : ((progress.currentMbps ?? progress.downloadMbps ?? progress.uploadMbps ?? 0) /
          SPEEDTEST_GAUGE_MAX_MBPS) *
          100
  )

  const displayNetwork = useMemo(() => {
    if (result) {
      return {
        localIp: result.localIp,
        publicIp: result.publicIp,
        interfaceName: result.interfaceName,
        colo: result.colo
      }
    }
    return {
      localIp: network?.localIp ?? progress.localIp ?? null,
      publicIp: network?.publicIp ?? progress.publicIp ?? null,
      interfaceName: network?.interfaceName ?? progress.interfaceName ?? null,
      colo: network?.colo ?? progress.colo ?? null
    }
  }, [network, progress, result])

  async function start(): Promise<void> {
    setRunning(true)
    setResult(null)
    setProgress({ ...INITIAL_PROGRESS, message: 'Menyiapkan speed test...' })
    try {
      const next = await window.speedTest.start()
      setResult(next)
      setNetwork({
        localIp: next.localIp,
        publicIp: next.publicIp,
        interfaceName: next.interfaceName,
        colo: next.colo,
        location: next.colo ? `Cloudflare ${next.colo}` : null
      })
    } catch {
      // Progress event already carries the user-facing error/cancelled state.
    } finally {
      setRunning(false)
    }
  }

  async function cancel(): Promise<void> {
    await window.speedTest.cancel()
  }

  return (
    <motion.section
      className="speedtest-page"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      aria-labelledby="speedtest-title"
    >
      <header className="page-header speedtest-page__header">
        <p className="page-header__eyebrow">Uji koneksi</p>
        <h1 id="speedtest-title">Speed Test</h1>
        <p>
          Ukur latency, download, dan upload dengan multi-stream agar hasil mendekati kapasitas
          jaringan nyata.
        </p>
      </header>

      <div className="network-meta" aria-label="Informasi jaringan">
        <NetworkChip
          label="IP lokal"
          value={displayNetwork.localIp}
          hint={displayNetwork.interfaceName}
        />
        <NetworkChip label="IP publik" value={displayNetwork.publicIp} />
        <NetworkChip
          label="Server"
          value={progress.server || result?.server || 'Cloudflare'}
          hint={displayNetwork.colo ? `PoP ${displayNetwork.colo}` : undefined}
        />
      </div>

      <div className="speedtest-stage">
        <div className="speedtest-stage__copy">
          <p className="speedtest-phase">{mainMetric.label}</p>
          <h2>
            {mainMetric.value} <span>{mainMetric.unit}</span>
          </h2>
          <p className="speedtest-message">{progress.message}</p>
          <div className="speedtest-progress" aria-label="Progress speed test">
            <motion.span
              animate={{ width: `${Math.round(progress.progress * 100)}%` }}
              transition={spring}
            />
          </div>
          <div className="speedtest-actions">
            {running ? (
              <button type="button" className="btn-ghost" onClick={() => void cancel()}>
                <IconPlayerStop size={13} />
                Batalkan
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={() => void start()}>
                <IconPlayerPlay size={13} />
                Mulai uji
              </button>
            )}
            <span className="speedtest-server">
              {PARALLEL_HINT}
            </span>
          </div>
        </div>

        <div className="speedtest-stage__gauge">
          <Gauge
            percentage={gaugePercent}
            value={mainMetric.value}
            unit={mainMetric.unit}
            alive={running}
            ariaLabel={`${mainMetric.label} ${mainMetric.value} ${mainMetric.unit}`}
          />
        </div>
      </div>

      <div className="speedtest-results" aria-label="Hasil speed test">
        <MetricCard label="Latency" value={formatLatency(result?.latencyMs ?? progress.latencyMs)} unit="ms" />
        <MetricCard
          label="Download"
          value={formatMbpsValue(result?.downloadMbps ?? progress.downloadMbps)}
          unit="Mbps"
          active={progress.phase === 'download'}
        />
        <MetricCard
          label="Upload"
          value={formatMbpsValue(result?.uploadMbps ?? progress.uploadMbps)}
          unit="Mbps"
          active={progress.phase === 'upload'}
        />
      </div>

      <AnimatePresence>
        {progress.phase === 'error' ? (
          <motion.p
            className="speedtest-error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {progress.error || 'Speed test gagal. Coba lagi nanti.'}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </motion.section>
  )
}

const PARALLEL_HINT = '6 stream · warmup 2s · steady 8s'

function NetworkChip({
  label,
  value,
  hint
}: {
  label: string
  value: string | null | undefined
  hint?: string | null
}): ReactElement {
  return (
    <div>
      <span>{label}</span>
      <strong className="mono">{value || '—'}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  )
}

function MetricCard({
  label,
  value,
  unit,
  active
}: {
  label: string
  value: string
  unit: string
  active?: boolean
}): ReactElement {
  return (
    <motion.div
      className={`metric-card${active ? ' metric-card--active' : ''}`}
      layout
      transition={spring}
    >
      <span>{label}</span>
      <strong className="mono">{value}</strong>
      <small>{unit}</small>
    </motion.div>
  )
}

function formatMbpsValue(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--'
  }
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1)
}

function formatLatency(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--'
  }
  return String(Math.round(value))
}
