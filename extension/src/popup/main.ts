import browser from 'webextension-polyfill'
import { getSettings, setSettings } from '../shared/settings'

const statusEl = document.getElementById('status') as HTMLParagraphElement
const captureEl = document.getElementById('capture') as HTMLInputElement
const minMbEl = document.getElementById('minMb') as HTMLInputElement
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement

async function refreshStatus(): Promise<void> {
  statusEl.textContent = 'Memeriksa…'
  statusEl.className = 'status'
  try {
    const response = (await Promise.race([
      browser.runtime.sendMessage({ type: 'arus:status' }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Waktu habis — pastikan Arus berjalan')), 10000)
      )
    ])) as {
      ok?: boolean
      error?: string
      extensionId?: string
    }
    const idHint = response?.extensionId ? ` · id ${response.extensionId}` : ''
    if (response?.ok) {
      statusEl.textContent = `Terhubung ke Arus${idHint}`
      statusEl.className = 'status ok'
    } else {
      statusEl.textContent = `${response?.error || 'Arus tidak terhubung'}${idHint}`
      statusEl.className = 'status err'
    }
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : 'Gagal memeriksa status'
    statusEl.className = 'status err'
  }
}

async function load(): Promise<void> {
  const settings = await getSettings()
  captureEl.checked = settings.captureEnabled
  minMbEl.value = String(Math.round(settings.minBytes / (1024 * 1024)) || 0)
  await refreshStatus()
}

captureEl.addEventListener('change', () => {
  void setSettings({ captureEnabled: captureEl.checked })
})

minMbEl.addEventListener('change', () => {
  const mb = Math.max(0, Number(minMbEl.value) || 0)
  void setSettings({ minBytes: mb * 1024 * 1024 })
})

refreshBtn.addEventListener('click', () => {
  void refreshStatus()
})

void load()
