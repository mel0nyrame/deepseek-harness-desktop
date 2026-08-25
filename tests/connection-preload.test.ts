import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopPreload,
  desktopWindowWebPreferences,
  type ContextBridgeLike,
  type IpcRendererLike,
} from '../packages/connection/src/preload.js'

class FakeIpcRenderer implements IpcRendererLike {
  readonly sent: Array<{ channel: string; args: unknown[] }> = []
  readonly invoked: Array<{ channel: string; value: unknown }> = []
  private readonly listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>()

  invoke(channel: string, value: unknown): Promise<unknown> {
    this.invoked.push({ channel, value })
    return Promise.resolve({ status: 200, headers: [], body: '{}' })
  }

  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args })
  }

  on(channel: string, listener: (event: unknown, value: unknown) => void): this {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
    return this
  }

  off(channel: string, listener: (event: unknown, value: unknown) => void): this {
    this.listeners.get(channel)?.delete(listener)
    return this
  }

  receive(channel: string, value: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener({}, value)
  }
}

describe('desktop context-isolated preload', () => {
  it('exposes only the narrow connection bridge and uses fixed IPC channels', async () => {
    const ipc = new FakeIpcRenderer()
    const exposed = new Map<string, unknown>()
    const contextBridge: ContextBridgeLike = {
      exposeInMainWorld(name, value) { exposed.set(name, value) },
    }
    const installed = createDesktopPreload(contextBridge, ipc)
    expect([...exposed.keys()]).toEqual(['dshDesktop'])
    expect(Object.keys(installed.bridge)).toEqual([
      'request', 'cancelRequest', 'subscribe', 'cancelSubscription', 'ackStream', 'onStream',
    ])

    await installed.bridge.request({
      id: 'request-1', url: 'dsh://app/api/session.list', method: 'POST',
      headers: [['content-type', 'application/json']], body: '{}',
    })
    installed.bridge.cancelRequest('request-1')
    installed.bridge.subscribe('stream-1', 'mux')
    installed.bridge.ackStream('stream-1')
    installed.bridge.cancelSubscription('stream-1')

    expect(ipc.invoked).toEqual([{ channel: 'dsh:request', value: expect.any(Object) }])
    expect(ipc.sent.map(message => message.channel)).toEqual([
      'dsh:cancel-request', 'dsh:subscribe', 'dsh:stream-ack', 'dsh:cancel-subscription',
    ])
    installed.dispose()
  })

  it('rejects malformed renderer calls before they reach Electron main', async () => {
    const ipc = new FakeIpcRenderer()
    const installed = createDesktopPreload({ exposeInMainWorld() {} }, ipc)
    await expect(installed.bridge.request({
      id: '', url: 'https://example.com/api/session.list', method: '', headers: [],
    })).rejects.toThrow('invalid desktop request')
    expect(() => { installed.bridge.subscribe('', 'mux') }).toThrow('invalid desktop subscription')
    expect(() => { installed.bridge.cancelRequest('') }).toThrow('invalid desktop request id')
    expect(ipc.invoked).toEqual([])
    expect(ipc.sent).toEqual([])
    installed.dispose()
  })

  it('cancels pending unary requests during disposal', async () => {
    const ipc = new FakeIpcRenderer()
    let completeInvoke: ((value: unknown) => void) | undefined
    ipc.invoke = (channel, value) => {
      ipc.invoked.push({ channel, value })
      return new Promise(resolve => { completeInvoke = resolve })
    }
    const installed = createDesktopPreload({ exposeInMainWorld() {} }, ipc)
    const pending = installed.bridge.request({
      id: 'pending-request', url: 'dsh://app/api/session.list', method: 'POST', headers: [], body: '{}',
    })

    installed.dispose()
    expect(ipc.sent).toContainEqual({ channel: 'dsh:cancel-request', args: ['pending-request'] })
    completeInvoke?.({ status: 200, headers: [], body: '{}' })
    await expect(pending).resolves.toEqual({ status: 200, headers: [], body: '{}' })
  })

  it('validates stream envelopes, isolates listeners, and stops dispatch after disposal', () => {
    const ipc = new FakeIpcRenderer()
    const installed = createDesktopPreload({ exposeInMainWorld() {} }, ipc)
    const received: unknown[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unsubscribeThrower = installed.bridge.onStream(() => { throw new Error('listener failed') })
    const unsubscribe = installed.bridge.onStream(event => { received.push(event) })
    installed.bridge.subscribe('mux-1', 'mux')
    installed.bridge.subscribe('host-1', 'host')

    ipc.receive('dsh:stream', { type: 'message', id: 'mux-1', message: { bad: true } })
    ipc.receive('dsh:stream', {
      type: 'message', id: 'mux-1',
      message: {
        type: 'server-request', rpcId: 'rpc-1', method: 'session/subscribed',
        payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 1 },
      },
    })
    expect(received).toHaveLength(1)
    expect(error).toHaveBeenCalledTimes(2)
    expect(ipc.sent).toContainEqual({ channel: 'dsh:stream-ack', args: ['mux-1'] })

    unsubscribeThrower()
    unsubscribe()
    installed.dispose()
    expect(ipc.sent).toContainEqual({ channel: 'dsh:cancel-subscription', args: ['mux-1'] })
    expect(ipc.sent).toContainEqual({ channel: 'dsh:cancel-subscription', args: ['host-1'] })
    ipc.receive('dsh:stream', { type: 'end', id: 'mux-1' })
    expect(received).toHaveLength(1)
    error.mockRestore()
  })

  it('pins the renderer security settings at the shell boundary', () => {
    expect(desktopWindowWebPreferences('/app/preload.js')).toEqual({
      preload: '/app/preload.js', sandbox: true, nodeIntegration: false, contextIsolation: true,
    })
  })
})
