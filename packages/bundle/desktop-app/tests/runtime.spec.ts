import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import {
  DesktopHostRuntime,
  type DesktopChildEndpoint,
  type DesktopChildMessage,
  type DesktopParentMessage,
} from '../src/index.ts'

class FakeEndpoint extends EventEmitter implements DesktopChildEndpoint {
  connected = true
  readonly sent: DesktopChildMessage[] = []
  blockStreamMessages = false
  private readonly pendingSends: Array<(error: Error | null) => void> = []

  send(message: DesktopChildMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    if (this.blockStreamMessages && message.type === 'stream-message') {
      if (callback !== undefined) this.pendingSends.push(callback)
      return false
    }
    callback?.(null)
    return true
  }

  receive(message: DesktopParentMessage): void {
    this.emit('message', message)
  }

  releaseOneSend(): void {
    this.pendingSends.shift()?.(null)
  }
}

async function *frames<F>(values: readonly RpcRequest<F>[]): AsyncGenerator<RpcRequest<F>> {
  for (const value of values) yield value
}

function makeContext(onRequest?: (request: Request) => void, loaderReady = Promise.resolve()): Context {
  const ctx = new Context()
  ctx.provide('loader', { await: () => loaderReady })
  ctx.provide('clientModules', {
    graph: () => ({
      rev: 'desktop-test',
      entries: [{ id: '@fixture/client', url: '/plugins/client.js', rev: 'one' }],
    }),
    clientPath: () => '/fixture/client.js',
  } as unknown as ClientModuleRegistry)
  const api = {
    sessions: {
      list: (request: { rpcId: ReturnType<typeof RpcId> }) => Promise.resolve({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [] } },
      }),
    },
    events: {
      mux: () => frames<MuxFrame>([
        {
          rpcId: RpcId('mux-1'),
          payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 1 },
        },
        {
          rpcId: RpcId('mux-2'),
          payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 2 },
        },
      ]),
      host: () => frames<HostFrame>([]),
    },
  } as unknown as ApiProxy
  ctx.provide('apiProxy', api)
  ctx.provide('connection', {
    rpc: {},
    createSharedFetchHandler: (_channel, fallback) => ({
      fetch(request: Request) {
        onRequest?.(request)
        return fallback.fetch(request)
      },
    }),
  } as HostConnectionHandle)
  return ctx
}

describe('desktop child runtime', () => {
  it('waits for readiness work to quiesce without publishing after disposal', async () => {
    const endpoint = new FakeEndpoint()
    const loader = Promise.withResolvers<undefined>()
    const runtime = new DesktopHostRuntime(makeContext(undefined, loader.promise), endpoint)
    runtime.start()

    const disposing = runtime.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    loader.resolve(undefined)
    await disposing
    expect(endpoint.sent).toEqual([])
  })

  it('announces local client bundles and carries unary plus ordered stream traffic', async () => {
    const endpoint = new FakeEndpoint()
    let requestUrl: string | undefined
    const runtime = new DesktopHostRuntime(makeContext((request) => { requestUrl = request.url }), endpoint)
    runtime.start()
    await vi.waitFor(() => {
      expect(endpoint.sent[0]).toEqual({
        type: 'ready',
        graph: {
          rev: 'desktop-test',
          entries: [{ id: '@fixture/client', url: '/plugins/client.js', rev: 'one' }],
        },
        bundles: [{ id: '@fixture/client', path: '/fixture/client.js' }],
      })
    })

    endpoint.receive({
      type: 'request',
      id: 'request-1',
      url: 'dsh://app/api/session.list',
      method: 'POST',
      headers: [['content-type', 'application/json']],
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'session.list', payload: {},
      }),
    })
    await vi.waitFor(() => {
      expect(endpoint.sent).toContainEqual(expect.objectContaining({
        type: 'response', id: 'request-1', status: 200,
      }))
    })
    const response = endpoint.sent.find(message => message.type === 'response')
    if (response?.type !== 'response') throw new Error('response missing')
    expect(requestUrl).toBe('http://127.0.0.1/api/session.list')
    expect(JSON.parse(response.body)).toEqual({
      type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { items: [] } },
    })

    endpoint.receive({ type: 'subscribe', id: 'stream-1', stream: 'mux' })
    await vi.waitFor(() => {
      expect(endpoint.sent.filter(message => message.type === 'stream-message')).toHaveLength(1)
    })
    endpoint.receive({ type: 'stream-ack', id: 'stream-1' })
    await vi.waitFor(() => {
      expect(endpoint.sent.filter(message => message.type === 'stream-message')).toHaveLength(2)
    })
    endpoint.receive({ type: 'stream-ack', id: 'stream-1' })
    await vi.waitFor(() => {
      expect(endpoint.sent.at(-1)).toEqual({ type: 'stream-end', id: 'stream-1' })
    })
    expect(endpoint.sent.filter(message => message.type === 'stream-message')).toEqual([
      {
        type: 'stream-message',
        id: 'stream-1',
        message: {
          type: 'server-request', rpcId: 'mux-1', method: 'session/subscribed',
          payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 1 },
        },
      },
      {
        type: 'stream-message',
        id: 'stream-1',
        message: {
          type: 'server-request', rpcId: 'mux-2', method: 'session/subscribed',
          payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 2 },
        },
      },
    ])
    await runtime.dispose()
    expect(endpoint.listenerCount('message')).toBe(0)
  })

  it('drops a malformed parent request before the shared API dispatcher', async () => {
    const endpoint = new FakeEndpoint()
    let requests = 0
    const runtime = new DesktopHostRuntime(makeContext(() => { requests += 1 }), endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })

    endpoint.receive({
      type: 'request',
      id: 'request-1',
      url: 'https://evil.test/api/session.list',
      method: 'POST',
      headers: [],
      body: '{}',
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(requests).toBe(0)
    await runtime.dispose()
  })

  it('waits for child IPC backpressure to settle before sending the next ordered frame', async () => {
    const endpoint = new FakeEndpoint()
    const runtime = new DesktopHostRuntime(makeContext(), endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })
    endpoint.blockStreamMessages = true

    endpoint.receive({ type: 'subscribe', id: 'stream-1', stream: 'mux' })

    await vi.waitFor(() => {
      expect(endpoint.sent.filter(message => message.type === 'stream-message')).toHaveLength(1)
    })
    expect(endpoint.sent.some(message => message.type === 'stream-error')).toBe(false)
    expect(endpoint.sent.some(message => message.type === 'stream-end')).toBe(false)

    endpoint.releaseOneSend()
    endpoint.receive({ type: 'stream-ack', id: 'stream-1' })
    await vi.waitFor(() => {
      expect(endpoint.sent.filter(message => message.type === 'stream-message')).toHaveLength(2)
    })
    endpoint.releaseOneSend()
    endpoint.receive({ type: 'stream-ack', id: 'stream-1' })
    await vi.waitFor(() => { expect(endpoint.sent.at(-1)).toEqual({ type: 'stream-end', id: 'stream-1' }) })
    await runtime.dispose()
  })

  it('terminates the existing source when a duplicate subscription id is rejected', async () => {
    const endpoint = new FakeEndpoint()
    const runtime = new DesktopHostRuntime(makeContext(), endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })

    endpoint.receive({ type: 'subscribe', id: 'mux-1', stream: 'mux' })
    endpoint.receive({ type: 'subscribe', id: 'mux-1', stream: 'host' })

    await vi.waitFor(() => {
      expect(endpoint.sent.filter(message => message.type === 'stream-error' && message.id === 'mux-1')).toEqual([{
        type: 'stream-error', id: 'mux-1', message: 'duplicate subscription id',
      }])
      expect(endpoint.sent.at(-1)).toEqual({ type: 'stream-end', id: 'mux-1' })
    })
    await runtime.dispose()
  })

  it('limits each logical child stream to one active subscription', async () => {
    const endpoint = new FakeEndpoint()
    const runtime = new DesktopHostRuntime(makeContext(), endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })

    endpoint.receive({ type: 'subscribe', id: 'mux-1', stream: 'mux' })
    endpoint.receive({ type: 'subscribe', id: 'mux-2', stream: 'mux' })

    await vi.waitFor(() => {
      expect(endpoint.sent.filter(message => message.type !== 'ready' && message.id === 'mux-2')).toEqual([
        { type: 'stream-error', id: 'mux-2', message: 'desktop-app: duplicate mux subscription' },
        { type: 'stream-end', id: 'mux-2' },
      ])
    })
    await runtime.dispose()
  })
})
