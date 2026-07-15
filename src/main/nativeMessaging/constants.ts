export const NATIVE_HOST_NAME = 'com.genghero.arus'
export const CHROME_EXTENSION_ID = 'pnmkpgoolmmekpecphmakboegpajanmc'
export const FIREFOX_EXTENSION_ID = 'arus@genghero.com'
export const PIPE_NAME =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\com.genghero.arus.bridge'
    : '/tmp/com.genghero.arus.bridge.sock'

export type BridgeRequest =
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

export type BridgeResponse =
  | { type: 'pong'; ok: true; version: string; app: 'Arus' }
  | { type: 'download-result'; ok: true; id: string }
  | { type: 'error'; ok: false; error: string }
