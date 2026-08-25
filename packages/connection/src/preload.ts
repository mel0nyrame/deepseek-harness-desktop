/** Narrow context-isolated renderer bridge for the desktop connection. */

import type { DesktopBridge, DesktopStream, DesktopStreamEvent } from './carrier.js'
import {
  parseDesktopBridgeRequest,
  parseDesktopBridgeResponse,
  parseDesktopStreamEvent,
} from './protocol.js'

/** Electron contextBridge subset used by this package. */
export interface ContextBridgeLike {
  exposeInMainWorld(name: string, value: unknown): void
}

/** Electron ipcRenderer subset used by this package. */
export interface IpcRendererLike {
  invoke(channel: string, value: unknown): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, value: unknown) => void): this
  off(channel: string, listener: (event: unknown, value: unknown) => void): this
}

/** Security settings the Electron shell must use for the product renderer. */
export function desktopWindowWebPreferences(preload: string): {
  preload: string
  sandbox: true
  nodeIntegration: false
  contextIsolation: true
} {
  return { preload, sandbox: true, nodeIntegration: false, contextIsolation: true }
}

function assertId(id: string, label: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256 || id.includes('\0')) {
    throw new Error(`invalid desktop ${label}`)
  }
}

/** Install the fixed-channel preload bridge and return its disposer for tests/lifecycle owners. */
export function createDesktopPreload(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
): { readonly bridge: DesktopBridge; dispose(): void } {
  const listeners = new Set<(event: DesktopStreamEvent) => void>()
  const requests = new Set<string>()
  const subscriptions = new Map<string, DesktopStream>()
  let disposed = false
  const assertActive = (): void => {
    if (disposed) throw new Error('desktop preload bridge is disposed')
  }
  const onStream = (_event: unknown, value: unknown): void => {
    const parsed = parseDesktopStreamEvent(value, subscriptions)
    if (parsed === undefined) {
      console.error('[desktop-preload] dropped malformed stream IPC message')
      if (typeof value === 'object' && value !== null && 'id' in value
        && typeof value.id === 'string' && subscriptions.has(value.id)) {
        ipcRenderer.send('dsh:stream-ack', value.id)
      }
      return
    }
    for (const listener of listeners) {
      try {
        listener(parsed)
      } catch (error) {
        console.error('[desktop-preload] stream listener threw:', error)
      }
    }
  }
  ipcRenderer.on('dsh:stream', onStream)

  const bridge: DesktopBridge = {
    async request(value) {
      assertActive()
      const request = parseDesktopBridgeRequest(value)
      if (request === undefined) throw new Error('invalid desktop request')
      if (requests.has(request.id)) throw new Error('duplicate desktop request id')
      requests.add(request.id)
      try {
        const response = parseDesktopBridgeResponse(await ipcRenderer.invoke('dsh:request', request))
        if (response === undefined) throw new Error('malformed desktop response')
        return response
      } finally {
        requests.delete(request.id)
      }
    },
    cancelRequest(id) {
      assertActive()
      assertId(id, 'request id')
      ipcRenderer.send('dsh:cancel-request', id)
    },
    subscribe(id, stream) {
      assertActive()
      assertId(id, 'subscription')
      if (stream !== 'mux' && stream !== 'host' || subscriptions.has(id)) {
        throw new Error('invalid desktop subscription')
      }
      subscriptions.set(id, stream)
      ipcRenderer.send('dsh:subscribe', id, stream)
    },
    cancelSubscription(id) {
      assertActive()
      assertId(id, 'subscription id')
      subscriptions.delete(id)
      ipcRenderer.send('dsh:cancel-subscription', id)
    },
    ackStream(id) {
      assertActive()
      assertId(id, 'stream acknowledgement')
      ipcRenderer.send('dsh:stream-ack', id)
    },
    onStream(listener) {
      assertActive()
      if (typeof listener !== 'function') throw new Error('invalid desktop stream listener')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  contextBridge.exposeInMainWorld('dshDesktop', bridge)
  return {
    bridge,
    dispose() {
      if (disposed) return
      disposed = true
      const activeRequests = [...requests]
      const activeSubscriptions = [...subscriptions.keys()]
      requests.clear()
      subscriptions.clear()
      listeners.clear()
      ipcRenderer.off('dsh:stream', onStream)
      for (const [channel, ids] of [
        ['dsh:cancel-request', activeRequests],
        ['dsh:cancel-subscription', activeSubscriptions],
      ] as const) {
        for (const id of ids) {
          try {
            ipcRenderer.send(channel, id)
          } catch (error) {
            console.error(`[desktop-preload] ${channel} failed:`, error)
          }
        }
      }
    },
  }
}
