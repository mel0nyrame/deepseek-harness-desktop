/** Narrow context-isolated renderer bridge. */

import { contextBridge, ipcRenderer } from 'electron'
import type { RendererStreamEvent } from './renderer-ipc.ts'

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

contextBridge.exposeInMainWorld('__DSH_BOOT__', boot)
contextBridge.exposeInMainWorld('dshDesktop', {
  request: (request: RendererRequest): Promise<RendererResponse> => ipcRenderer.invoke('dsh:request', request),
  cancelRequest: (id: string): void => { ipcRenderer.send('dsh:cancel-request', id) },
  subscribe: (id: string, stream: 'mux' | 'host'): void => { ipcRenderer.send('dsh:subscribe', id, stream) },
  cancelSubscription: (id: string): void => { ipcRenderer.send('dsh:cancel-subscription', id) },
  onStream: (listener: (message: RendererStreamEvent) => void): (() => void) => {
    const handler = (_event: unknown, message: RendererStreamEvent): void => { listener(message) }
    ipcRenderer.on('dsh:stream', handler)
    return () => { ipcRenderer.removeListener('dsh:stream', handler) }
  },
})
