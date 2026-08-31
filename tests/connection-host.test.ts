import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  inject,
  internals,
  type DesktopChildEndpoint,
  type DesktopChildMessage,
  type DesktopParentMessage,
} from '../packages/connection/src/index.js'

class FakeEndpoint extends EventEmitter implements DesktopChildEndpoint {
  connected = true
  readonly sent: DesktopChildMessage[] = []

  send(message: DesktopChildMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }

  receive(message: DesktopParentMessage | unknown): void {
    this.emit('message', message)
  }

  disconnect(): void {
    this.connected = false
    this.emit('disconnect')
  }
}

async function *muxFrames() {
  yield {
    rpcId: 'mux-1',
    payload: { type: 'session/subscribed' as const, sessionId: 'session-1', lastSeq: 1 },
  }
  yield {
    rpcId: 'mux-2',
    payload: { type: 'session/subscribed' as const, sessionId: 'session-1', lastSeq: 2 },
  }
}

function apiProxy(): Record<string, unknown> {
  return {
    sessions: {
      list: (message: { rpcId: string }) => Promise.resolve({
        rpcId: message.rpcId, result: { ok: true, value: { items: [] } },
      }),
    },
    events: {
      mux: () => muxFrames(),
      host: async function *() {},
    },
  }
}

async function mount(endpoint = new FakeEndpoint(), api: unknown = apiProxy()): Promise<{
  ctx: ReturnType<typeof internals.createContext>
  endpoint: FakeEndpoint
  dispose(): Promise<void>
}> {
  const ctx = internals.createContext()
  ctx.provide('apiProxy', api as never)
  internals.endpoint = endpoint
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, endpoint, dispose: () => fiber.dispose() }
}

describe('desktop Host connection provider', () => {
  it('provides the existing Host contract without WebServer or a network listener', async () => {
    const before = activeNetworkListeners()
    const mounted = await mount()
    try {
      expect(mounted.ctx.get('connection')).toBeDefined()
      expect(mounted.ctx.get('webServer')).toBeUndefined()
      expect(mounted.endpoint.sent).toContainEqual({ type: 'connection-ready' })
      expect(activeNetworkListeners()).toEqual(before)
    } finally {
      await mounted.dispose()
    }
    expect(mounted.endpoint.listenerCount('message')).toBe(0)
    expect(mounted.endpoint.listenerCount('disconnect')).toBe(0)
  })

  it('routes /api and registered generic RPC channels through fetch-shaped handlers', async () => {
    const mounted = await mount()
    try {
      mounted.ctx.connection.rpc.handle('/rpc', async (endpoint: string, payload: unknown) => ({
        ok: true, value: { endpoint, payload },
      }), { authority: 'loopback' })

      mounted.endpoint.receive(request('api-1', '/api/session.list', 'session.list', {}))
      mounted.endpoint.receive(request('rpc-1', '/rpc/ping', 'ping', { value: 1 }))
      await vi.waitFor(() => { expect(responses(mounted.endpoint)).toHaveLength(2) })
      expect(responseBody(mounted.endpoint, 'api-1')).toMatchObject({
        type: 'server-response', result: { ok: true, value: { items: [] } },
      })
      expect(responseBody(mounted.endpoint, 'rpc-1')).toMatchObject({
        type: 'server-response', result: { ok: true, value: { endpoint: 'ping', payload: { value: 1 } } },
      })
    } finally {
      await mounted.dispose()
    }
  })

  it('paces ordered streams with acknowledgements and releases them on disconnect', async () => {
    const mounted = await mount()
    mounted.endpoint.receive({ type: 'subscribe', id: 'mux-stream', stream: 'mux' })
    await vi.waitFor(() => {
      expect(mounted.endpoint.sent).toContainEqual({ type: 'stream-open', id: 'mux-stream' })
    })
    mounted.endpoint.receive({ type: 'stream-ack', id: 'mux-stream' })
    await vi.waitFor(() => {
      expect(mounted.endpoint.sent.filter(message => message.type === 'stream-message')).toHaveLength(1)
    })
    mounted.endpoint.receive({ type: 'stream-ack', id: 'mux-stream' })
    await vi.waitFor(() => {
      expect(mounted.endpoint.sent.filter(message => message.type === 'stream-message')).toHaveLength(2)
    })
    const frames = mounted.endpoint.sent.filter(message => message.type === 'stream-message')
    expect(frames.map(frame => (frame.message as { rpcId: string }).rpcId)).toEqual(['mux-1', 'mux-2'])
    mounted.endpoint.disconnect()
    await mounted.dispose()
    expect(mounted.endpoint.listenerCount('message')).toBe(0)
  })

  it('retains an acknowledgement that arrives before the stream pump waits for it', async () => {
    const mounted = await mount()
    const originalSend = mounted.endpoint.send.bind(mounted.endpoint)
    mounted.endpoint.send = (message, callback) => {
      const sent = originalSend(message, callback)
      if (message.type === 'stream-open' || message.type === 'stream-message') {
        mounted.endpoint.receive({ type: 'stream-ack', id: message.id })
      }
      return sent
    }
    mounted.endpoint.receive({ type: 'subscribe', id: 'early-ack', stream: 'mux' })
    await vi.waitFor(() => {
      expect(mounted.endpoint.sent.filter(message => message.type === 'stream-message')).toHaveLength(2)
    })
    await mounted.dispose()
  })

  it('drops malformed parent messages without allocating a request or subscription', async () => {
    const mounted = await mount()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const sentBeforeMalformedMessage = mounted.endpoint.sent.length
      mounted.endpoint.receive({ type: 'request', id: '', url: 'https://evil.invalid', method: 42 })
      await Promise.resolve()
      expect(mounted.endpoint.sent).toHaveLength(sentBeforeMalformedMessage)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
      await mounted.dispose()
    }
  })

  it('contains synchronous stream-source failures and releases the logical stream slot', async () => {
    let attempts = 0
    const api = apiProxy()
    const events = api.events as Record<string, unknown>
    events.mux = () => {
      attempts += 1
      if (attempts === 1) throw new Error('mux source failed during creation')
      return muxFrames()
    }
    const mounted = await mount(new FakeEndpoint(), api)
    try {
      expect(() => {
        mounted.endpoint.receive({ type: 'subscribe', id: 'failed-mux', stream: 'mux' })
      }).not.toThrow()
      await vi.waitFor(() => {
        expect(mounted.endpoint.sent).toContainEqual({
          type: 'stream-error', id: 'failed-mux', message: 'mux source failed during creation',
        })
        expect(mounted.endpoint.sent).toContainEqual({ type: 'stream-end', id: 'failed-mux' })
      })

      mounted.endpoint.receive({ type: 'subscribe', id: 'next-mux', stream: 'mux' })
      await vi.waitFor(() => {
        expect(mounted.endpoint.sent).toContainEqual({ type: 'stream-open', id: 'next-mux' })
      })
    } finally {
      await mounted.dispose()
    }
  })
})

function request(id: string, path: string, method: string, payload: unknown): DesktopParentMessage {
  return {
    type: 'request', id, url: `dsh://app${path}`, method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
  }
}

function responses(endpoint: FakeEndpoint): Array<Extract<DesktopChildMessage, { type: 'response' }>> {
  return endpoint.sent.filter(message => message.type === 'response')
}

function responseBody(endpoint: FakeEndpoint, id: string): unknown {
  const message = responses(endpoint).find(candidate => candidate.id === id)
  if (message === undefined) throw new Error(`missing response ${id}`)
  return JSON.parse(message.body)
}

function activeNetworkListeners(): string[] {
  const getActiveHandles = Reflect.get(process, '_getActiveHandles') as () => unknown[]
  const handles = getActiveHandles.call(process)
  return handles.flatMap((handle) => {
    if (typeof handle !== 'object' || handle === null || !('address' in handle)
      || typeof handle.address !== 'function') return []
    const address = handle.address() as unknown
    return address === null ? [] : [JSON.stringify(address)]
  }).toSorted()
}
