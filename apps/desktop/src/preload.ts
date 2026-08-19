/** Narrow context-isolated renderer bridge. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  parseRendererStreamEvent,
  type RendererStreamEvent,
  type RendererThemePreference,
} from './renderer-ipc.ts'

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
  // No acknowledgement here: the consuming client acknowledges each event
  // only after it has processed it, so Electron main paces the DSH child on
  // real renderer consumption instead of on synchronous dispatch.
  for (const listener of [...streamListeners]) {
    try {
      listener(message)
    } catch (error) {
      console.error('[desktop-preload] stream listener threw:', error)
    }
  }
})

contextBridge.exposeInMainWorld('__DSH_BOOT__', boot)
contextBridge.exposeInMainWorld('dshNativeTheme', {
  setPreference: (preference: RendererThemePreference): void => {
    ipcRenderer.send('dsh:set-theme-preference', preference)
  },
})
contextBridge.exposeInMainWorld('dshDesktop', {
  request: (request: RendererRequest): Promise<RendererResponse> => ipcRenderer.invoke('dsh:request', request),
  cancelRequest: (id: string): void => { ipcRenderer.send('dsh:cancel-request', id) },
  subscribe: (id: string, stream: 'mux' | 'host'): void => { ipcRenderer.send('dsh:subscribe', id, stream) },
  cancelSubscription: (id: string): void => { ipcRenderer.send('dsh:cancel-subscription', id) },
  ackStream: (id: string): void => { ipcRenderer.send('dsh:stream-ack', id) },
  onStream: (listener: (message: RendererStreamEvent) => void): (() => void) => {
    streamListeners.add(listener)
    return () => { streamListeners.delete(listener) }
  },
})

// The Host lifecycle status page is the only frame that may request recovery
// actions; Electron main validates the sender URL again before acting.
if (window.location.href === 'dsh://app/status.html') {
  contextBridge.exposeInMainWorld('dshRecovery', (action: 'restart' | 'quit'): Promise<void> => {
    return ipcRenderer.invoke('dsh:recovery', action)
  })
}
