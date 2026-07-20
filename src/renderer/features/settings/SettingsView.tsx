import type { ReactElement } from 'react'
import { motion } from 'framer-motion'
import type { AppSettings, BrowserIntegrationStatus } from '../../../shared/downloadTypes'
import { spring } from '../../motion'

const MIN_SEGMENT_PRESETS = [
  { label: '256 KB', value: 256 * 1024 },
  { label: '512 KB', value: 512 * 1024 },
  { label: '1 MB', value: 1024 * 1024 },
  { label: '2 MB', value: 2 * 1024 * 1024 }
]

export interface SettingsViewProps {
  settings: AppSettings
  browserStatus: BrowserIntegrationStatus | null
  onSaveConnections: (value: number) => Promise<void>
  onSaveSettings: (settings: Partial<AppSettings>) => Promise<void>
  onReinstallNativeHost: () => Promise<void>
  onOpenExtensionFolder: () => Promise<void>
}

export function SettingsView({
  settings,
  browserStatus,
  onSaveConnections,
  onSaveSettings,
  onReinstallNativeHost,
  onOpenExtensionFolder
}: SettingsViewProps): ReactElement {
  const bridgeLabel = settings.browserIntegrationEnabled
    ? browserStatus?.bridgeListening
      ? 'Bridge aktif'
      : 'Bridge tidak aktif'
    : 'Dimatikan'
  const hostLabel = browserStatus?.hostInstalled ? 'Host terpasang' : 'Host belum terpasang'

  return (
    <motion.section
      className="settings-page"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      aria-labelledby="settings-page-title"
    >
      <header className="page-header">
        <p className="page-header__eyebrow">Preferensi Arus</p>
        <h1 id="settings-page-title">Pengaturan</h1>
        <p>
          Atur cara Arus memakai koneksi, berperilaku saat startup, dan berkomunikasi dengan
          ekstensi browser.
        </p>
      </header>

      <div className="settings-grid">
        <section className="settings-card">
          <div className="settings-card__head">
            <div>
              <h2>Unduhan</h2>
              <p>Kontrol perilaku dasar saat Arus mengunduh file.</p>
            </div>
          </div>

          <label className="setting-row setting-row--range">
            <span>
              <strong>Koneksi paralel per unduhan</strong>
              <small>
                Jumlah koneksi HTTP untuk satu file. Naikkan untuk file besar, turunkan jika server
                membatasi koneksi dari IP yang sama.
              </small>
            </span>
            <div className="settings-range">
              <input
                type="range"
                min={4}
                max={16}
                step={1}
                value={settings.connections}
                onChange={(event) => void onSaveConnections(Number(event.target.value))}
              />
              <span className="settings-range__value mono">{settings.connections}</span>
            </div>
          </label>

          <label className="setting-row setting-row--range">
            <span>
              <strong>Unduhan paralel maksimum</strong>
              <small>
                Berapa banyak file yang boleh berjalan bersamaan di antrean. Sisanya menunggu
                sampai ada slot kosong.
              </small>
            </span>
            <div className="settings-range">
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={settings.maxConcurrentDownloads}
                onChange={(event) =>
                  void onSaveSettings({ maxConcurrentDownloads: Number(event.target.value) })
                }
              />
              <span className="settings-range__value mono">{settings.maxConcurrentDownloads}</span>
            </div>
          </label>

          <label className="setting-row setting-row--range">
            <span>
              <strong>Ukuran minimum segmen</strong>
              <small>
                Ambang sisa byte sebelum Arus berhenti membagi segmen. Nilai lebih besar mengurangi
                overhead request; lebih kecil meningkatkan paralelisme pada file sedang.
              </small>
            </span>
            <div className="settings-range">
              <select
                value={nearestPreset(settings.minSegmentSizeBytes)}
                onChange={(event) =>
                  void onSaveSettings({ minSegmentSizeBytes: Number(event.target.value) })
                }
              >
                {MIN_SEGMENT_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          </label>

          <label className="setting-row setting-row--range">
            <span>
              <strong>Retry per segmen</strong>
              <small>
                Berapa kali Arus mencoba ulang satu koneksi yang gagal sebelum menandai unduhan
                gagal.
              </small>
            </span>
            <div className="settings-range">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={settings.maxSegmentRetries}
                onChange={(event) =>
                  void onSaveSettings({ maxSegmentRetries: Number(event.target.value) })
                }
              />
              <span className="settings-range__value mono">{settings.maxSegmentRetries}</span>
            </div>
          </label>

          <label className="setting-row">
            <span>
              <strong>Tampilkan di folder saat selesai</strong>
              <small>Buka Explorer/Finder dan sorot file ketika unduhan berhasil selesai.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.revealOnComplete}
              onChange={(event) => void onSaveSettings({ revealOnComplete: event.target.checked })}
            />
          </label>
        </section>

        <section className="settings-card">
          <div className="settings-card__head">
            <div>
              <h2>Startup</h2>
              <p>Pastikan Arus siap menangkap unduhan dari browser.</p>
            </div>
          </div>

          <label className="setting-row">
            <span>
              <strong>Jalankan Arus saat login</strong>
              <small>
                Arus dimulai tersembunyi di system tray/menu bar agar ekstensi browser bisa
                langsung mengirim unduhan.
              </small>
              {!browserStatus?.loginItemSupported ? (
                <small className="setting-row__warning">
                  Tersedia setelah aplikasi Arus di-install. Mode dev tidak mengubah startup sistem.
                </small>
              ) : null}
            </span>
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              disabled={browserStatus ? !browserStatus.loginItemSupported : true}
              onChange={(event) => void onSaveSettings({ launchAtLogin: event.target.checked })}
            />
          </label>
        </section>

        <section className="settings-card settings-card--wide">
          <div className="settings-card__head">
            <div>
              <h2>Integrasi browser</h2>
              <p>Hubungkan ekstensi Chrome/Firefox ke Arus lewat Native Messaging.</p>
            </div>
            <div className="status-badges" aria-label="Status integrasi browser">
              <span className="status-badge">{bridgeLabel}</span>
              <span className="status-badge">{hostLabel}</span>
            </div>
          </div>

          <label className="setting-row">
            <span>
              <strong>Browser integration (Native Messaging)</strong>
              <small>
                Jika aktif, ekstensi browser dapat memindahkan unduhan ke Arus dan menampilkan
                modal konfirmasi sebelum download dimulai.
              </small>
              {browserStatus?.lastError ? (
                <small className="setting-row__warning">{browserStatus.lastError}</small>
              ) : null}
            </span>
            <input
              type="checkbox"
              checked={settings.browserIntegrationEnabled}
              onChange={(event) =>
                void onSaveSettings({ browserIntegrationEnabled: event.target.checked })
              }
            />
          </label>

          <div className="settings-actions">
            <button type="button" className="btn-ghost" onClick={() => void onReinstallNativeHost()}>
              Pasang ulang native host
            </button>
            <button type="button" className="btn-ghost" onClick={() => void onOpenExtensionFolder()}>
              Buka folder ekstensi
            </button>
          </div>

          <details className="settings-details">
            <summary>Detail ekstensi dan host</summary>
            <div className="settings-details__body mono">
              Chrome ID: {browserStatus?.chromeExtensionId || '—'}
              <br />
              Firefox ID: {browserStatus?.firefoxExtensionId || '—'}
              <br />
              Host: {browserStatus?.hostName || 'com.arus.app'}
              <br />
              Chrome/Edge: Load unpacked extension/dist/chrome
              <br />
              Firefox: load extension/dist/firefox
            </div>
          </details>
        </section>
      </div>
    </motion.section>
  )
}

function nearestPreset(value: number): number {
  let best = MIN_SEGMENT_PRESETS[1]!.value
  let bestDelta = Number.POSITIVE_INFINITY
  for (const preset of MIN_SEGMENT_PRESETS) {
    const delta = Math.abs(preset.value - value)
    if (delta < bestDelta) {
      best = preset.value
      bestDelta = delta
    }
  }
  return best
}
