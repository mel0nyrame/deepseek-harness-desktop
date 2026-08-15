/** Narrow context-isolated renderer bridge. */

import { contextBridge, ipcRenderer } from 'electron'
import { parseRendererStreamEvent, type RendererStreamEvent } from './renderer-ipc.ts'

interface RendererRequest {
  readonly id: string
  readonly url: string
  readonly method: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body?: string
}

interface RendererResponse {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly body: string
}

const boot: unknown = ipcRenderer.sendSync('dsh:boot')
const streamListeners = new Set<(message: RendererStreamEvent) => void>()

ipcRenderer.on('dsh:stream', (_event: unknown, value: unknown) => {
  const message = parseRendererStreamEvent(value)
  if (message === undefined) {
    console.error('[desktop-preload] dropped malformed stream IPC message')
    return
  }
  for (const listener of [...streamListeners]) {
    try {
      listener(message)
    } catch (error) {
      console.error('[desktop-preload] stream listener threw:', error)
    }
  }
  ipcRenderer.send('dsh:stream-ack', message.id)
})

contextBridge.exposeInMainWorld('__DSH_BOOT__', boot)
contextBridge.exposeInMainWorld('dshDesktop', {
  request: (request: RendererRequest): Promise<RendererResponse> => ipcRenderer.invoke('dsh:request', request),
  cancelRequest: (id: string): void => { ipcRenderer.send('dsh:cancel-request', id) },
  subscribe: (id: string, stream: 'mux' | 'host'): void => { ipcRenderer.send('dsh:subscribe', id, stream) },
  cancelSubscription: (id: string): void => { ipcRenderer.send('dsh:cancel-subscription', id) },
  onStream: (listener: (message: RendererStreamEvent) => void): (() => void) => {
    streamListeners.add(listener)
    return () => { streamListeners.delete(listener) }
  },
})
