import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import type { AddDownloadInput } from '../../shared/downloadTypes'
import { PIPE_NAME, type BridgeRequest, type BridgeResponse } from './constants'

type BridgeHandlers = {
  isEnabled: () => boolean
  proposeDownload: (
    input: AddDownloadInput & { requestId?: string; fileSize?: number | null }
  ) => { id: string }
  onDownloadProposed?: (id: string) => void
  getVersion?: () => string
}

export class NativeBridgeServer {
  private server: Server | null = null
  private readonly handlers: BridgeHandlers

  constructor(handlers: BridgeHandlers) {
    this.handlers = handlers
  }

  isListening(): boolean {
    return Boolean(this.server?.listening)
  }

  async start(): Promise<void> {
    if (!this.handlers.isEnabled()) {
      await this.stop()
      return
    }
    if (this.server?.listening) {
      return
    }

    await this.stop()
    await cleanupPipe()

    const server = createServer((socket) => {
      void this.handleSocket(socket)
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(PIPE_NAME, () => {
        if (process.platform !== 'win32') {
          try {
            chmodSync(PIPE_NAME, 0o600)
          } catch {
            // ignore
          }
        }
        server.off('error', reject)
        resolve()
      })
    })

    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) {
      await cleanupPipe()
      return
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    await cleanupPipe()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  private async handleSocket(socket: Socket): Promise<void> {
    let buffer = ''
    socket.setEncoding('utf8')

    const reply = (response: BridgeResponse): void => {
      try {
        socket.write(`${JSON.stringify(response)}\n`)
      } catch {
        // ignore
      }
      socket.end()
    }

    socket.on('data', (chunk) => {
      buffer += chunk
      const idx = buffer.indexOf('\n')
      if (idx < 0) {
        return
      }
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)

      try {
        const request = JSON.parse(raw) as BridgeRequest
        reply(this.dispatch(request))
      } catch (error) {
        reply({
          type: 'error',
          ok: false,
          error: error instanceof Error ? error.message : 'Invalid bridge request'
        })
      }
    })

    socket.on('error', () => {
      // ignore client disconnects
    })
  }

  private dispatch(request: BridgeRequest): BridgeResponse {
    if (!this.handlers.isEnabled()) {
      return { type: 'error', ok: false, error: 'Browser integration disabled in Arus' }
    }

    if (request.type === 'ping') {
      return {
        type: 'pong',
        ok: true,
        app: 'Arus',
        version: this.handlers.getVersion?.() || '0.1.0'
      }
    }

    if (request.type === 'download') {
      const url = typeof request.url === 'string' ? request.url.trim() : ''
      if (!url) {
        return { type: 'error', ok: false, error: 'Missing url' }
      }

      const headers = { ...(request.headers || {}) }
      if (request.cookie && !headers.Cookie) {
        headers.Cookie = request.cookie
      }

      try {
        const pending = this.handlers.proposeDownload({
          url,
          requestId: request.requestId,
          referrer: request.referrer,
          fileName: request.fileName,
          fileSize: request.fileSize,
          headers
        })
        this.handlers.onDownloadProposed?.(pending.id)
        return { type: 'download-pending', ok: true, id: pending.id }
      } catch (error) {
        return {
          type: 'error',
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to add download'
        }
      }
    }

    return { type: 'error', ok: false, error: 'Unknown request type' }
  }
}

async function cleanupPipe(): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  try {
    if (existsSync(PIPE_NAME)) {
      unlinkSync(PIPE_NAME)
    }
  } catch {
    // ignore
  }
}
