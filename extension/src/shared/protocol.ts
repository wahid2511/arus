/** Shared constant: must match Electron native host registration. */
export const NATIVE_HOST_NAME = 'com.genghero.arus'

/** Stable unpacked Chrome extension ID (from embedded manifest key). */
export const CHROME_EXTENSION_ID = 'pnmkpgoolmmekpecphmakboegpajanmc'

/** Firefox add-on ID (gecko). */
export const FIREFOX_EXTENSION_ID = 'arus@genghero.com'

export type NativeRequest =
  | { type: 'ping' }
  | {
      type: 'download'
      url: string
      referrer?: string
      fileName?: string
      fileSize?: number | null
      headers?: Record<string, string>
      cookie?: string
    }

export type NativeResponse =
  | { type: 'pong'; ok: true; version: string; app: 'Arus' }
  | { type: 'download-result'; ok: true; id: string }
  | { type: 'error'; ok: false; error: string }

export interface ExtensionSettings {
  captureEnabled: boolean
  /** Minimum bytes before auto-capture (0 = capture all eligible). */
  minBytes: number
  /** Comma/space-ish list of extensions to always capture, e.g. zip,exe,msi */
  alwaysCaptureExtensions: string
}
