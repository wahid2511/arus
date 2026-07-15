import browser from 'webextension-polyfill'
import { NATIVE_HOST_NAME, type NativeRequest, type NativeResponse } from './protocol'

const DEFAULT_TIMEOUT_MS = 8000

export async function sendNative(
  request: NativeRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<NativeResponse> {
  try {
    const response = await Promise.race([
      browser.runtime.sendNativeMessage(NATIVE_HOST_NAME, request) as Promise<
        NativeResponse | undefined
      >,
      new Promise<NativeResponse>((resolve) => {
        setTimeout(
          () =>
            resolve({
              type: 'error',
              ok: false,
              error:
                'Timeout menghubungi Arus — pastikan aplikasi Arus berjalan dan native host terpasang'
            }),
          timeoutMs
        )
      })
    ])

    if (!response || typeof response !== 'object') {
      return { type: 'error', ok: false, error: 'Empty response from Arus native host' }
    }
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      /Specified native messaging host not found|Access to the specified native messaging host is forbidden|native messaging host .+ not found|Forbidden/i.test(
        message
      )
    ) {
      return {
        type: 'error',
        ok: false,
        error:
          'Native host tidak cocok / belum terpasang. Buka Arus → Pengaturan → Pasang ulang native host, lalu Reload ekstensi. Cek ID ekstensi harus pnmkpgoolmmekpecphmakboegpajanmc'
      }
    }
    if (/Failed to start native messaging host|Native host has exited|disconnected/i.test(message)) {
      return {
        type: 'error',
        ok: false,
        error: 'Arus tidak berjalan atau native host gagal start'
      }
    }
    return { type: 'error', ok: false, error: message }
  }
}

export async function pingArus(timeoutMs = 6000): Promise<{ ok: boolean; error?: string }> {
  const response = await sendNative({ type: 'ping' }, timeoutMs)
  if (response.ok && response.type === 'pong') {
    return { ok: true }
  }
  return {
    ok: false,
    error: response.type === 'error' ? response.error : 'Arus unreachable'
  }
}
