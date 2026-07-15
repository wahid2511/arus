import browser from 'webextension-polyfill'
import type { ExtensionSettings } from './protocol'

export const DEFAULT_SETTINGS: ExtensionSettings = {
  captureEnabled: true,
  minBytes: 0,
  alwaysCaptureExtensions: 'zip,7z,rar,exe,msi,iso,dmg,pkg,deb,rpm,apk,tar,gz,mp4,mkv,avi'
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await browser.storage.local.get(DEFAULT_SETTINGS)
  return {
    captureEnabled: Boolean(stored.captureEnabled ?? DEFAULT_SETTINGS.captureEnabled),
    minBytes: Number(stored.minBytes ?? DEFAULT_SETTINGS.minBytes) || 0,
    alwaysCaptureExtensions: String(
      stored.alwaysCaptureExtensions ?? DEFAULT_SETTINGS.alwaysCaptureExtensions
    )
  }
}

export async function setSettings(partial: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings()
  const next: ExtensionSettings = {
    ...current,
    ...partial
  }
  await browser.storage.local.set(next)
  return next
}
