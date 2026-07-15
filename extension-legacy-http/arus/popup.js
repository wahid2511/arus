const api = typeof browser !== 'undefined' ? browser : chrome

const statusEl = document.getElementById('status')
const urlEl = document.getElementById('url')
const sendBtn = document.getElementById('send')
const optionsBtn = document.getElementById('options')
const messageEl = document.getElementById('message')

function showMessage(text, isError = false) {
  messageEl.hidden = false
  messageEl.textContent = text
  messageEl.classList.toggle('error', isError)
}

async function refreshStatus() {
  statusEl.textContent = 'Memeriksa…'
  const response = await api.runtime.sendMessage({ type: 'arus:ping' })
  if (response?.ok) {
    statusEl.textContent = `Terhubung · port ${response.settings.port}`
  } else {
    statusEl.textContent = response?.error
      ? `Tidak terhubung · ${response.error}`
      : 'Arus tidak aktif'
  }
}

sendBtn.addEventListener('click', async () => {
  const url = urlEl.value.trim()
  if (!url) {
    showMessage('Isi URL dulu', true)
    return
  }

  sendBtn.disabled = true
  try {
    const response = await api.runtime.sendMessage({ type: 'arus:download', url })
    if (!response?.ok) {
      throw new Error(response?.error || 'Gagal mengirim')
    }
    showMessage('Terkirim ke Arus')
    urlEl.value = ''
    await refreshStatus()
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), true)
  } finally {
    sendBtn.disabled = false
  }
})

optionsBtn.addEventListener('click', () => {
  api.runtime.openOptionsPage()
})

void refreshStatus()
