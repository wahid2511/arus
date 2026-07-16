import browser from 'webextension-polyfill'
import { pingArus, sendNative } from '../shared/nativeHost'
import { getSettings } from '../shared/settings'

const CAPTURED = new Set<number>()

function fileNameOnly(path: string | undefined): string | undefined {
  if (!path) {
    return undefined
  }
  return path.split(/[\\/]/).pop() || path
}

function extensionOf(fileName: string | undefined): string {
  const base = fileNameOnly(fileName)
  if (!base) {
    return ''
  }
  const idx = base.lastIndexOf('.')
  return idx >= 0 ? base.slice(idx + 1).toLowerCase() : ''
}

function shouldCapture(
  item: browser.Downloads.DownloadItem,
  settings: Awaited<ReturnType<typeof getSettings>>
): boolean {
  if (!settings.captureEnabled) {
    return false
  }
  if (!item.url || item.url.startsWith('blob:') || item.url.startsWith('data:')) {
    return false
  }
  if (item.byExtensionId) {
    return false
  }

  const ext = extensionOf(item.filename)
  const allowExt = settings.alwaysCaptureExtensions
    .split(/[,\s]+/)
    .map((part) => part.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean)

  if (ext && allowExt.includes(ext)) {
    return true
  }

  if (settings.minBytes > 0) {
    return item.fileSize > 0 && item.fileSize >= settings.minBytes
  }

  return Boolean(item.filename) || Boolean(item.mime && item.mime !== 'text/html')
}

async function buildCookieHeader(url: string): Promise<string | undefined> {
  try {
    const cookies = await browser.cookies.getAll({ url })
    if (!cookies.length) {
      return undefined
    }
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  } catch {
    return undefined
  }
}

async function setBadge(text: string, color = '#F0A63F'): Promise<void> {
  try {
    await browser.action.setBadgeText({ text })
    await browser.action.setBadgeBackgroundColor({ color })
  } catch {
    // ignore
  }
}

async function clearBadgeSoon(ms = 2500): Promise<void> {
  setTimeout(() => {
    void setBadge('')
  }, ms)
}

async function notify(title: string, message: string, isError = false): Promise<void> {
  console[isError ? 'error' : 'log']('[Arus]', title, message)

  await setBadge(isError ? '!' : 'OK', isError ? '#E2574C' : '#2DD4BF')
  void clearBadgeSoon()

  try {
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-128.png'),
      title,
      message
    })
  } catch (error) {
    console.error('[Arus] notification failed', error)
  }
}

async function sendDownloadToArus(input: {
  url: string
  requestId?: string
  referrer?: string
  fileName?: string
  fileSize?: number | null
}): Promise<void> {
  const cookie = await buildCookieHeader(input.url)
  const headers: Record<string, string> = {
    'User-Agent': typeof navigator !== 'undefined' ? navigator.userAgent : 'ArusExtension'
  }
  if (input.referrer) {
    headers.Referer = input.referrer
  }

  const response = await sendNative({
    type: 'download',
    url: input.url,
    requestId: input.requestId,
    referrer: input.referrer,
    fileName: input.fileName,
    fileSize: input.fileSize ?? null,
    headers,
    cookie
  })

  if (!response.ok) {
    throw new Error(response.type === 'error' ? response.error : 'Arus rejected download')
  }
}

async function handoffToArus(item: browser.Downloads.DownloadItem): Promise<boolean> {
  try {
    await sendDownloadToArus({
      url: item.finalUrl || item.url,
      requestId: String(item.id),
      referrer: item.referrer || undefined,
      fileName: fileNameOnly(item.filename),
      fileSize: item.fileSize > 0 ? item.fileSize : null
    })
    return true
  } catch {
    return false
  }
}

async function interceptDownload(item: browser.Downloads.DownloadItem): Promise<void> {
  if (CAPTURED.has(item.id)) {
    return
  }
  CAPTURED.add(item.id)

  const settings = await getSettings()
  if (!shouldCapture(item, settings)) {
    return
  }

  const accepted = await handoffToArus(item)
  if (!accepted) {
    // Leave browser download running.
    return
  }

  try {
    await browser.downloads.cancel(item.id)
  } catch {
    // ignore
  }
  try {
    await browser.downloads.erase({ id: item.id })
  } catch {
    // ignore
  }

  await setBadge('OK', '#2DD4BF')
  void clearBadgeSoon()
}

async function ensureContextMenus(): Promise<void> {
  try {
    await browser.contextMenus.removeAll()
  } catch {
    // ignore
  }

  await browser.contextMenus.create({
    id: 'arus-download-link',
    title: 'Download with Arus',
    contexts: ['link', 'image', 'video', 'audio']
  })

  await browser.contextMenus.create({
    id: 'arus-download-page',
    title: 'Download page with Arus',
    contexts: ['page']
  })
}

browser.runtime.onInstalled.addListener(() => {
  void ensureContextMenus()
})

browser.runtime.onStartup.addListener(() => {
  void ensureContextMenus()
})

// MV3 service workers can restart without onInstalled — recreate menus on every boot.
void ensureContextMenus()

browser.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    try {
      await setBadge('…', '#F0A63F')

      let url: string | undefined
      if (info.menuItemId === 'arus-download-link') {
        url = info.linkUrl || info.srcUrl
      } else if (info.menuItemId === 'arus-download-page') {
        url = info.pageUrl || tab?.url
      }

      if (!url) {
        throw new Error('URL tidak ditemukan')
      }

      await sendDownloadToArus({
        url,
        referrer: info.pageUrl || tab?.url
      })

      await notify('Arus', 'Unduhan dikirim ke Arus')
    } catch (error) {
      await notify(
        'Arus gagal',
        error instanceof Error ? error.message : String(error),
        true
      )
    }
  })()
})

browser.downloads.onCreated.addListener((item) => {
  void interceptDownload(item)
})

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'arus:status') {
    void pingArus()
      .then((result) =>
        sendResponse({
          ...result,
          extensionId: browser.runtime.id
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          extensionId: browser.runtime.id
        })
      )
    return true
  }
  sendResponse({ ok: false, error: 'Unknown message', extensionId: browser.runtime.id })
  return false
})
