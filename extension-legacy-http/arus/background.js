/* Arus browser companion — Chrome MV3 service worker + Firefox background script */

const DEFAULTS = {
  enabled: true,
  captureBrowserDownloads: true,
  port: 17831,
  token: '',
  minBytes: 0
}

const api = typeof browser !== 'undefined' ? browser : chrome

async function getSettings() {
  const stored = await api.storage.local.get(DEFAULTS)
  return { ...DEFAULTS, ...stored }
}

async function setBadge(text, color = '#F0A63F') {
  try {
    await api.action.setBadgeText({ text })
    await api.action.setBadgeBackgroundColor({ color })
  } catch {
    // older browsers
  }
}

async function probeHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
    method: 'GET',
    cache: 'no-store'
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json()
}

async function pairWithArus(port) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: 'GET',
    cache: 'no-store'
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.ok || !payload.token) {
    throw new Error(
      payload.error ||
        (response.status === 0
          ? 'Arus tidak berjalan — buka aplikasi Arus dulu'
          : `Gagal pairing (HTTP ${response.status})`)
    )
  }

  const nextPort = Number(payload.port) || port
  await api.storage.local.set({
    token: String(payload.token),
    port: nextPort
  })

  return {
    token: String(payload.token),
    port: nextPort
  }
}

async function ensureLinked(settings) {
  if (settings.token) {
    return settings
  }

  try {
    const paired = await pairWithArus(settings.port)
    return { ...settings, token: paired.token, port: paired.port }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      throw new Error('Arus tidak berjalan — buka aplikasi Arus dulu')
    }
    throw error
  }
}

async function sendToArus({ url, referrer, fileName }) {
  let settings = await getSettings()
  if (!settings.enabled) {
    throw new Error('Integrasi Arus dimatikan di ekstensi')
  }

  settings = await ensureLinked(settings)

  const response = await fetch(`http://127.0.0.1:${settings.port}/v1/downloads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Arus-Token': settings.token
    },
    body: JSON.stringify({
      url,
      referrer: referrer || undefined,
      fileName: fileName || undefined
    })
  })

  const payload = await response.json().catch(() => ({}))

  // Token may be stale after Arus settings were regenerated — re-pair once.
  if (response.status === 401) {
    const paired = await pairWithArus(settings.port)
    const retry = await fetch(`http://127.0.0.1:${paired.port}/v1/downloads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Arus-Token': paired.token
      },
      body: JSON.stringify({
        url,
        referrer: referrer || undefined,
        fileName: fileName || undefined
      })
    })
    const retryPayload = await retry.json().catch(() => ({}))
    if (!retry.ok || !retryPayload.ok) {
      throw new Error(retryPayload.error || `HTTP ${retry.status}`)
    }
    await setBadge('OK', '#2DD4BF')
    setTimeout(() => setBadge(''), 1500)
    return retryPayload
  }

  if (!response.ok || !payload.ok) {
    if (/Failed to fetch|NetworkError|Load failed/i.test(String(payload.error || ''))) {
      throw new Error('Arus tidak berjalan — buka aplikasi Arus dulu')
    }
    throw new Error(payload.error || `HTTP ${response.status}`)
  }

  await setBadge('OK', '#2DD4BF')
  setTimeout(() => setBadge(''), 1500)
  return payload
}

async function notify(title, message) {
  try {
    await api.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title,
      message
    })
  } catch {
    // ignore
  }
}

function shouldCaptureDownload(item, settings) {
  if (!settings.enabled || !settings.captureBrowserDownloads) {
    return false
  }
  if (!item || !item.url) {
    return false
  }
  if (item.url.startsWith('blob:') || item.url.startsWith('data:')) {
    return false
  }
  if (item.byExtensionId) {
    return false
  }
  if (settings.minBytes > 0 && item.fileSize > 0 && item.fileSize < settings.minBytes) {
    return false
  }
  return true
}

api.runtime.onInstalled.addListener(async () => {
  try {
    await api.contextMenus.removeAll()
  } catch {
    // ignore
  }

  api.contextMenus.create({
    id: 'arus-download-link',
    title: 'Unduh dengan Arus',
    contexts: ['link', 'image', 'video', 'audio']
  })

  api.contextMenus.create({
    id: 'arus-download-page',
    title: 'Unduh halaman ini dengan Arus',
    contexts: ['page']
  })

  // Auto-pair on install if Arus is already running.
  try {
    const settings = await getSettings()
    if (!settings.token) {
      await pairWithArus(settings.port)
    }
  } catch {
    // Arus may not be running yet
  }
})

api.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    let url = null
    let fileName = undefined

    if (info.menuItemId === 'arus-download-link') {
      url = info.linkUrl || info.srcUrl
    } else if (info.menuItemId === 'arus-download-page') {
      url = info.pageUrl || tab?.url
    }

    if (!url) {
      throw new Error('URL tidak ditemukan')
    }

    await sendToArus({
      url,
      referrer: info.pageUrl || tab?.url,
      fileName
    })
    await notify('Arus', 'Unduhan dikirim ke Arus')
  } catch (error) {
    await setBadge('!', '#E2574C')
    await notify('Arus gagal', error instanceof Error ? error.message : String(error))
  }
})

api.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings()
  if (!shouldCaptureDownload(item, settings)) {
    return
  }

  try {
    await api.downloads.cancel(item.id)
    try {
      await api.downloads.erase({ id: item.id })
    } catch {
      // ignore erase failures
    }

    await sendToArus({
      url: item.finalUrl || item.url,
      referrer: item.referrer,
      fileName: item.filename ? item.filename.split(/[\\/]/).pop() : undefined
    })
  } catch (error) {
    await setBadge('!', '#E2574C')
    console.error('[Arus] capture failed', error)
    await notify('Arus gagal', error instanceof Error ? error.message : String(error))
  }
})

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    if (message?.type === 'arus:ping') {
      const settings = await getSettings()
      try {
        const linked = await ensureLinked(settings)
        const health = await probeHealth(linked.port)
        sendResponse({
          ok: true,
          health,
          settings: {
            port: linked.port,
            enabled: linked.enabled,
            paired: Boolean(linked.token)
          }
        })
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          settings: { port: settings.port, enabled: settings.enabled, paired: Boolean(settings.token) }
        })
      }
      return
    }

    if (message?.type === 'arus:pair') {
      const settings = await getSettings()
      try {
        const paired = await pairWithArus(settings.port)
        sendResponse({ ok: true, port: paired.port, paired: true })
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      return
    }

    if (message?.type === 'arus:download' && message.url) {
      const result = await sendToArus({
        url: message.url,
        referrer: message.referrer,
        fileName: message.fileName
      })
      sendResponse({ ok: true, result })
      return
    }

    sendResponse({ ok: false, error: 'Unknown message' })
  })().catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
  })

  return true
})
