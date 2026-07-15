const api = typeof browser !== 'undefined' ? browser : chrome

const enabledEl = document.getElementById('enabled')
const captureEl = document.getElementById('capture')
const portEl = document.getElementById('port')
const tokenEl = document.getElementById('token')
const pairBtn = document.getElementById('pair')
const saveBtn = document.getElementById('save')
const testBtn = document.getElementById('test')
const messageEl = document.getElementById('message')

function showMessage(text, isError = false) {
  messageEl.hidden = false
  messageEl.textContent = text
  messageEl.classList.toggle('error', isError)
}

async function load() {
  const settings = await api.storage.local.get({
    enabled: true,
    captureBrowserDownloads: true,
    port: 17831,
    token: ''
  })
  enabledEl.checked = Boolean(settings.enabled)
  captureEl.checked = Boolean(settings.captureBrowserDownloads)
  portEl.value = String(settings.port || 17831)
  tokenEl.value = settings.token || ''
}

async function persistForm() {
  await api.storage.local.set({
    enabled: enabledEl.checked,
    captureBrowserDownloads: captureEl.checked,
    port: Number(portEl.value) || 17831,
    token: tokenEl.value.trim()
  })
}

pairBtn.addEventListener('click', async () => {
  await persistForm()
  const response = await api.runtime.sendMessage({ type: 'arus:pair' })
  if (response?.ok) {
    await load()
    showMessage(`Terhubung ke Arus · port ${response.port}`)
  } else {
    showMessage(response?.error || 'Gagal terhubung. Pastikan Arus berjalan.', true)
  }
})

saveBtn.addEventListener('click', async () => {
  await persistForm()
  showMessage('Disimpan')
})

testBtn.addEventListener('click', async () => {
  await persistForm()
  const response = await api.runtime.sendMessage({ type: 'arus:ping' })
  if (response?.ok) {
    await load()
    showMessage(`Terhubung ke Arus · port ${response.settings.port}`)
  } else {
    showMessage(response?.error || 'Gagal terhubung. Pastikan Arus berjalan.', true)
  }
})

void load()
