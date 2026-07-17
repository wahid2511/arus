import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { AppSettings, BrowserIntegrationStatus } from '../shared/downloadTypes'
import DownloadRow from './components/DownloadRow'
import Gauge from './components/Gauge'
import ActionToolbar from './components/ActionToolbar'
import { IconPlus, IconSettings } from './components/Icons'
import Sidebar from './components/Sidebar'
import type { SidebarFilter } from './components/Sidebar'
import TitleBar from './components/TitleBar'
import { countTasksByFilter, filterTasks, toDownloadRow } from './features/downloadList/taskHelpers'
import { StatOrb } from './features/speedHero/StatOrb'
import { useDownloads } from './hooks/useDownloads'
import { spring } from './motion'
import { formatSpeed, splitSpeed } from './utils/format'

const GAUGE_MAX_BYTES_PER_SEC = 100 * 1024 * 1024

export default function App(): ReactElement {
  const { tasks, refreshTasks, upsertLocalTask } = useDownloads()
  const [filter, setFilter] = useState<SidebarFilter>('all')
  const [peakSpeed, setPeakSpeed] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings>({
    connections: 8,
    revealOnComplete: true,
    browserIntegrationEnabled: true,
    launchAtLogin: true
  })
  const [browserStatus, setBrowserStatus] = useState<BrowserIntegrationStatus | null>(null)
  const [url, setUrl] = useState('')
  const [directory, setDirectory] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    void window.downloads.getSettings().then(setSettings)
    void window.downloads.getBrowserIntegrationStatus().then(setBrowserStatus)
  }, [])

  const stats = useMemo(() => {
    const active = tasks.filter((task) => task.status === 'downloading')
    const queued = tasks.filter((task) => task.status === 'queued')
    const totalSpeed = active.reduce((sum, task) => sum + task.speedBytesPerSecond, 0)
    return { active: active.length, queued: queued.length, totalSpeed }
  }, [tasks])

  const filterCounts = useMemo(() => countTasksByFilter(tasks), [tasks])

  useEffect(() => {
    if (stats.totalSpeed > peakSpeed) {
      setPeakSpeed(stats.totalSpeed)
    }
  }, [stats.totalSpeed, peakSpeed])

  const filteredTasks = useMemo(() => filterTasks(tasks, filter), [tasks, filter])

  const rows = useMemo(() => filteredTasks.map(toDownloadRow), [filteredTasks])

  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows])
  const selectedVisible = useMemo(
    () => visibleIds.filter((id) => selectedIds.has(id)),
    [visibleIds, selectedIds]
  )
  const selectedTasks = useMemo(
    () => tasks.filter((task) => selectedIds.has(task.id)),
    [tasks, selectedIds]
  )
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))

  const selectionFlags = useMemo(() => {
    const canResumeSelected = selectedTasks.some(
      (task) =>
        task.status === 'paused' || task.status === 'failed' || task.status === 'cancelled'
    )
    const canPauseSelected = selectedTasks.some(
      (task) => task.status === 'downloading' || task.status === 'queued'
    )
    const canRemoveSelected = selectedTasks.length > 0
    const canRevealSelected = selectedVisible.length === 1
    return { canResumeSelected, canPauseSelected, canRemoveSelected, canRevealSelected }
  }, [selectedTasks, selectedVisible])

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => tasks.some((task) => task.id === id)))
      return next.size === current.size ? current : next
    })
  }, [tasks])

  const gauge = splitSpeed(stats.totalSpeed)
  const gaugePercent = Math.min(100, (stats.totalSpeed / GAUGE_MAX_BYTES_PER_SEC) * 100)
  const alive = stats.totalSpeed > 0
  const hasActive = stats.active > 0 || stats.queued > 0
  const hasCompleted = tasks.some((task) => task.status === 'completed')

  async function addDownload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setMessage('')

    try {
      const task = await window.downloads.add({ url, directory: directory || undefined })
      upsertLocalTask(task)
      setUrl('')
      setDialogOpen(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Gagal menambah unduhan')
    }
  }

  async function chooseDirectory(): Promise<void> {
    const chosen = await window.downloads.chooseDirectory()
    if (chosen) {
      setDirectory(chosen)
    }
  }

  async function saveConnections(value: number): Promise<void> {
    const next = await window.downloads.setSettings({ connections: value })
    setSettings(next)
  }

  async function saveSettingsPartial(partial: Partial<AppSettings>): Promise<void> {
    const next = await window.downloads.setSettings(partial)
    setSettings(next)
    setBrowserStatus(await window.downloads.getBrowserIntegrationStatus())
  }

  async function reinstallNativeHost(): Promise<void> {
    setBrowserStatus(await window.downloads.installNativeHost())
  }

  async function openExtensionFolder(): Promise<void> {
    await window.downloads.openExtensionFolder()
  }

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
    } catch (error) {
      console.error(error)
    }
  }

  function toggleExpanded(id: string): void {
    setExpandedId((current) => (current === id ? null : id))
  }

  function toggleSelect(id: string, selected: boolean): void {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (selected) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
  }

  function toggleSelectAll(): void {
    setSelectedIds((current) => {
      if (allVisibleSelected) {
        const next = new Set(current)
        visibleIds.forEach((id) => next.delete(id))
        return next
      }
      const next = new Set(current)
      visibleIds.forEach((id) => next.add(id))
      return next
    })
  }

  async function refreshAfterBulk(): Promise<void> {
    await refreshTasks()
  }

  return (
    <div className="window-frame">
      <TitleBar
        onMinimize={() => window.windowControls?.minimize()}
        onMaximize={() => window.windowControls?.maximize()}
        onClose={() => window.windowControls?.close()}
      />

      <div className="app-body">
        <Sidebar active={filter} onSelect={setFilter} counts={filterCounts} />

        <main className="main-pane">
          <section className="speed-hero" aria-label="Kecepatan unduh">
            <div className="speed-hero__copy">
              <motion.p
                className="speed-hero__eyebrow"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={spring}
              >
                Kecepatan gabungan
              </motion.p>
              <div className="speed-hero__actions">
                <motion.button
                  type="button"
                  className="btn-ghost btn-icon"
                  aria-label="Pengaturan"
                  title={`Koneksi paralel: ${settings.connections}`}
                  onClick={() => setSettingsOpen(true)}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.94 }}
                >
                  <IconSettings size={14} />
                </motion.button>
                <motion.button
                  type="button"
                  className="btn-primary"
                  onClick={() => setDialogOpen(true)}
                  whileHover={{ scale: 1.03, y: -1 }}
                  whileTap={{ scale: 0.97 }}
                >
                  <IconPlus size={13} />
                  Unduhan baru
                </motion.button>
              </div>

              <div className="speed-hero__stats" aria-label="Statistik unduhan">
                <StatOrb label="Aktif" value={String(stats.active)} accent="teal" />
                <StatOrb label="Antrean" value={String(stats.queued)} />
                <StatOrb label="Puncak" value={formatSpeed(peakSpeed)} wide />
              </div>
            </div>

            <div className="speed-hero__gauge">
              <Gauge
                percentage={gaugePercent}
                value={gauge.value}
                unit={gauge.unit}
                alive={alive}
                ariaLabel={`Kecepatan unduh ${gauge.value} ${gauge.unit}`}
              />
            </div>
          </section>

          <ActionToolbar
            selectedCount={selectedVisible.length}
            visibleCount={visibleIds.length}
            hasActive={hasActive}
            hasCompleted={hasCompleted}
            canResumeSelected={selectionFlags.canResumeSelected}
            canPauseSelected={selectionFlags.canPauseSelected}
            canRemoveSelected={selectionFlags.canRemoveSelected}
            canRevealSelected={selectionFlags.canRevealSelected}
            allVisibleSelected={allVisibleSelected}
            onToggleSelectAll={toggleSelectAll}
            onStopAll={() =>
              void runAction(async () => {
                await window.downloads.pauseAll()
                await refreshAfterBulk()
              })
            }
            onResumeSelected={() =>
              void runAction(async () => {
                await window.downloads.resumeMany(selectedVisible)
                await refreshAfterBulk()
              })
            }
            onPauseSelected={() =>
              void runAction(async () => {
                await window.downloads.pauseMany(selectedVisible)
                await refreshAfterBulk()
              })
            }
            onRemoveSelected={() =>
              void runAction(async () => {
                await window.downloads.removeMany(selectedVisible)
                setSelectedIds(new Set())
                await refreshAfterBulk()
              })
            }
            onRemoveCompleted={() =>
              void runAction(async () => {
                await window.downloads.removeCompleted()
                await refreshAfterBulk()
              })
            }
            onRevealSelected={() => {
              const id = selectedVisible[0]
              if (id) {
                void runAction(() => window.downloads.revealInFolder(id))
              }
            }}
          />

          <div className="download-list" aria-label="Daftar unduhan">
            <AnimatePresence mode="popLayout">
              {rows.length === 0 ? (
                <motion.div
                  key="empty"
                  className="empty-state"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <p>Belum ada unduhan di sini.</p>
                </motion.div>
              ) : (
                rows.map((row) => (
                  <DownloadRow
                    key={row.id}
                    data={row}
                    expanded={expandedId === row.id}
                    selected={selectedIds.has(row.id)}
                    onToggle={toggleExpanded}
                    onSelect={toggleSelect}
                    onPause={(id) => void runAction(() => window.downloads.pause(id))}
                    onResume={(id) => void runAction(() => window.downloads.resume(id))}
                    onCancel={(id) => void runAction(() => window.downloads.cancel(id))}
                    onRemove={(id) =>
                      void runAction(async () => {
                        await window.downloads.remove(id)
                        setSelectedIds((current) => {
                          const next = new Set(current)
                          next.delete(id)
                          return next
                        })
                      })
                    }
                    onReveal={(id) => void runAction(() => window.downloads.revealInFolder(id))}
                  />
                ))
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>

      <AnimatePresence>
        {dialogOpen ? (
          <motion.div
            className="dialog-backdrop"
            role="presentation"
            onClick={() => setDialogOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-download-title"
              onClick={(event) => event.stopPropagation()}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.97 }}
              transition={spring}
            >
              <h2 id="new-download-title">Unduhan baru</h2>
              <form onSubmit={(event) => void addDownload(event)}>
                <label>
                  URL
                  <input
                    autoFocus
                    required
                    placeholder="https://example.com/file.zip"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </label>
                <label>
                  Folder tujuan
                  <div className="folder-row">
                    <input
                      placeholder="Default: Downloads"
                      value={directory}
                      onChange={(event) => setDirectory(event.target.value)}
                    />
                    <button type="button" className="btn-ghost" onClick={() => void chooseDirectory()}>
                      Pilih
                    </button>
                  </div>
                </label>
                {message ? <p className="dialog__error">{message}</p> : null}
                <div className="dialog__actions">
                  <button type="button" className="btn-ghost" onClick={() => setDialogOpen(false)}>
                    Batal
                  </button>
                  <button type="submit" className="btn-primary">
                    Mulai unduh
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {settingsOpen ? (
          <motion.div
            className="dialog-backdrop"
            role="presentation"
            onClick={() => setSettingsOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="dialog dialog--wide"
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
              onClick={(event) => event.stopPropagation()}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.97 }}
              transition={spring}
            >
              <h2 id="settings-title">Pengaturan</h2>
              <label>
                Koneksi paralel per unduhan
                <div className="settings-range">
                  <input
                    type="range"
                    min={4}
                    max={16}
                    step={1}
                    value={settings.connections}
                    onChange={(event) => void saveConnections(Number(event.target.value))}
                  />
                  <span className="settings-range__value mono">{settings.connections}</span>
                </div>
                <span className="settings-hint">
                  Default 8. Turunkan jika server membatasi banyak koneksi dari satu IP.
                </span>
              </label>

              <label className="settings-toggle">
                <span>Tampilkan di folder saat selesai</span>
                <input
                  type="checkbox"
                  checked={settings.revealOnComplete}
                  onChange={(event) =>
                    void saveSettingsPartial({ revealOnComplete: event.target.checked })
                  }
                />
              </label>
              <span className="settings-hint">
                Otomatis buka Explorer/Finder dan sorot file setelah unduhan selesai.
              </span>

              <label className="settings-toggle">
                <span>Jalankan Arus saat login</span>
                <input
                  type="checkbox"
                  checked={settings.launchAtLogin}
                  disabled={browserStatus ? !browserStatus.loginItemSupported : true}
                  onChange={(event) =>
                    void saveSettingsPartial({ launchAtLogin: event.target.checked })
                  }
                />
              </label>
              <span className="settings-hint">
                {browserStatus?.loginItemSupported
                  ? 'Arus dimulai tersembunyi di menu bar / system tray agar ekstensi selalu siap.'
                  : 'Tersedia pada aplikasi Arus yang sudah di-install; mode dev tidak mengubah startup sistem.'}
              </span>

              <div className="settings-section">
                <h3>Integrasi browser</h3>
                <label className="settings-toggle">
                  <span>Browser integration (Native Messaging)</span>
                  <input
                    type="checkbox"
                    checked={settings.browserIntegrationEnabled}
                    onChange={(event) =>
                      void saveSettingsPartial({
                        browserIntegrationEnabled: event.target.checked
                      })
                    }
                  />
                </label>
                <p className="settings-hint">
                  Status:{' '}
                  {browserStatus?.bridgeListening
                    ? 'bridge aktif'
                    : settings.browserIntegrationEnabled
                      ? 'bridge tidak mendengar'
                      : 'dimatikan'}
                  {' · '}
                  host {browserStatus?.hostInstalled ? 'terpasang' : 'belum terpasang'}
                  {browserStatus?.lastError ? ` · ${browserStatus.lastError}` : ''}
                  .
                </p>
                <p className="settings-hint mono">
                  Chrome ID: {browserStatus?.chromeExtensionId || '—'}
                  <br />
                  Firefox ID: {browserStatus?.firefoxExtensionId || '—'}
                  <br />
                  Host: {browserStatus?.hostName || 'com.genghero.arus'}
                </p>
                <div className="folder-row">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void reinstallNativeHost()}
                  >
                    Pasang ulang native host
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void openExtensionFolder()}
                  >
                    Buka folder ekstensi
                  </button>
                </div>
                <p className="settings-hint">
                  Chrome/Edge: Load unpacked <span className="mono">extension/dist/chrome</span>.
                  Firefox: load <span className="mono">extension/dist/firefox</span>. Pastikan Arus
                  berjalan sebelum menguji unduhan.
                </p>
              </div>

              <div className="dialog__actions">
                <button type="button" className="btn-primary" onClick={() => setSettingsOpen(false)}>
                  Selesai
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
