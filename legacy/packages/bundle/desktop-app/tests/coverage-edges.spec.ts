import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import {
  apply,
  DesktopHostRuntime,
  DesktopNativeActions,
  internals,
  type DesktopChildEndpoint,
  type DesktopChildMessage,
} from '../src/index.ts'

type MessageType = DesktopChildMessage['type']

class EdgeEndpoint extends EventEmitter implements DesktopChildEndpoint {
  connected = true
  readonly sent: DesktopChildMessage[] = []
  readonly callbackFailures = new Set<MessageType>()
  readonly throwOn = new Set<MessageType>()
  readonly doubleCallbacks = new Set<MessageType>()
  readonly blocked = new Map<MessageType, (error: Error | null) => void>()
  onSend: ((message: DesktopChildMessage) => void) | undefined

  send(message: DesktopChildMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    this.onSend?.(message)
    if (this.throwOn.has(message.type)) throw new Error(`thrown ${message.type}`)
    if (this.callbackFailures.has(message.type)) {
      callback?.(new Error(`callback ${message.type}`))
      return false
    }
    if (this.blocked.has(message.type)) {
      if (callback !== undefined) this.blocked.set(message.type, callback)
      return false
    }
    callback?.(null)
    if (this.doubleCallbacks.has(message.type)) callback?.(new Error('late callback'))
    return true
  }

  receive(message: unknown): void {
    this.emit('message', message)
  }

  release(type: MessageType): void {
    this.blocked.get(type)?.(null)
  }

  releaseWith(type: MessageType, error: Error): void {
    this.blocked.get(type)?.(error)
  }
}

function muxFrame(rpcId: string): RpcRequest<MuxFrame> {
  return {
    rpcId: RpcId(rpcId),
    payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 1 },
  }
}

function hostFrame(rpcId: string): RpcRequest<HostFrame> {
  return {
    rpcId: RpcId(rpcId),
    payload: { type: 'host/remote-event', event: 'settings/document-updated', args: [] },
  }
}

async function *frames<F>(values: readonly RpcRequest<F>[]): AsyncGenerator<RpcRequest<F>> {
  for (const value of values) yield value
}

function pickThrough(actions: DesktopNativeActions, signal: AbortSignal): Promise<string | null> {
  const capability = actions.capability()
  if (capability.kind !== 'native') throw new Error('native capability missing')
  return capability.pick(signal)
}

interface RuntimeContextOptions {
  loaderReady?: Promise<void>
  clientPath?: (id: string) => string | undefined
  muxFrames?: () => AsyncIterable<RpcRequest<MuxFrame>>
  hostFrames?: () => AsyncIterable<RpcRequest<HostFrame>>
  fetch?: (request: Request) => Promise<Response>
}

function makeRuntimeContext(options: RuntimeContextOptions = {}): Context {
  const ctx = new Context()
  ctx.provide('loader', { await: () => options.loaderReady ?? Promise.resolve() })
  ctx.provide('clientModules', {
    graph: () => ({
      rev: 'desktop-test',
      entries: [{ id: '@fixture/client', url: '/plugins/client.js', rev: 'one' }],
    }),
    clientPath: (id: string) => options.clientPath === undefined ? '/fixture/client.js' : options.clientPath(id),
  } as unknown as ClientModuleRegistry)
  const api = {
    sessions: {
      list: (request: { rpcId: ReturnType<typeof RpcId> }) => Promise.resolve({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [] } },
      }),
    },
    events: {
      mux: () => options.muxFrames?.() ?? frames<MuxFrame>([]),
      host: () => options.hostFrames?.() ?? frames<HostFrame>([]),
    },
  } as unknown as ApiProxy
  ctx.provide('apiProxy', api)
  ctx.provide('connection', {
    rpc: {},
    createSharedFetchHandler: (_channel, fallback) => ({
      async fetch(request: Request) {
        if (options.fetch !== undefined) return options.fetch(request)
        return fallback.fetch(request)
      },
    }),
  } as HostConnectionHandle)
  return ctx
}

describe('desktop app coverage edges', () => {
  it('drops every malformed parent message shape and accepts parsed control messages as no-ops', async () => {
    const endpoint = new EdgeEndpoint()
    const ctx = makeRuntimeContext()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const runtime = new DesktopHostRuntime(ctx, endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })

    const malformed: unknown[] = [
      null,
      {},
      { type: 'unknown', id: 'unknown-1' },
      { type: 'subscribe', id: 'bad-stream', stream: 'other' },
      { type: 'request', id: 'bad-url', url: 'not a URL', method: 'GET', headers: [] },
      { type: 'request', id: 'bad-scheme', url: 'https://evil.test/api/x', method: 'GET', headers: [] },
      { type: 'request', id: 'empty-method', url: 'dsh://app/api/x', method: '', headers: [] },
      { type: 'request', id: 'non-array-headers', url: 'dsh://app/api/x', method: 'GET', headers: 'headers' },
      { type: 'request', id: 'short-header', url: 'dsh://app/api/x', method: 'GET', headers: [['only-one']] },
      { type: 'request', id: 'non-string-body', url: 'dsh://app/api/x', method: 'GET', headers: [], body: 42 },
      { type: 'native-response', id: 'bad-value', result: { ok: true, value: null } },
      { type: 'native-response', id: 'bad-open', result: { ok: true, value: { type: 'open-path', opened: false } } },
      { type: 'native-response', id: 'unknown-value', result: { ok: true, value: { type: 'other' } } },
      { type: 'native-response', id: 'bad-result', result: null },
      { type: 'native-response', id: 'string-result', result: 'bad' },
    ]
    for (const message of malformed) endpoint.receive(message)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(malformed.length) })

    endpoint.receive({ type: 'cancel-request', id: 'missing-request' })
    endpoint.receive({ type: 'cancel-subscription', id: 'missing-subscription' })
    endpoint.receive({ type: 'stream-ack', id: 'missing-subscription' })
    endpoint.receive({
      type: 'native-response',
      id: 'missing-native',
      result: { ok: true, value: { type: 'pick-directory', path: null } },
    })
    await Promise.resolve()
    await runtime.dispose()
  })

  it('handles a request with no body, duplicate ids, dispatcher failure, and reply delivery failure', async () => {
    const endpoint = new EdgeEndpoint()
    let requests = 0
    const ctx = makeRuntimeContext({
      fetch: async (request) => {
        requests += 1
        if (request.url === 'http://127.0.0.1/api/throw') throw new Error('dispatcher down')
        return new Response(JSON.stringify({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: {} } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const runtime = new DesktopHostRuntime(ctx, endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })

    endpoint.receive({
      type: 'request', id: 'no-body', url: 'dsh://app/api/session.list', method: 'GET', headers: [],
    })
    await vi.waitFor(() => {
      expect(endpoint.sent.some(message => message.type === 'response' && message.id === 'no-body')).toBe(true)
    })

    endpoint.callbackFailures.add('request-error')
    endpoint.receive({
      type: 'request', id: 'duplicate', url: 'dsh://app/api/session.list', method: 'GET', headers: [],
    })
    endpoint.receive({
      type: 'request', id: 'duplicate', url: 'dsh://app/api/session.list', method: 'GET', headers: [],
    })
    await vi.waitFor(() => {
      expect(endpoint.sent.some(message => message.type === 'request-error' && message.id === 'duplicate')).toBe(true)
      expect(error).toHaveBeenCalled()
    })
    endpoint.callbackFailures.delete('request-error')

    endpoint.receive({
      type: 'request', id: 'throwing', url: 'dsh://app/api/throw', method: 'GET', headers: [],
    })
    await vi.waitFor(() => {
      expect(endpoint.sent.some(message => message.type === 'request-error' && message.id === 'throwing')).toBe(true)
    })

    endpoint.callbackFailures.add('response')
    endpoint.receive({
      type: 'request', id: 'reply-failure', url: 'dsh://app/api/session.list', method: 'GET', headers: [],
    })
    await vi.waitFor(() => {
      expect(error.mock.calls.some(args => String(args[0]).includes('request reply delivery failed'))).toBe(true)
    })
    endpoint.callbackFailures.delete('response')

    expect(requests).toBeGreaterThan(0)
    await runtime.dispose()
  })

  it('starts once, disposes before start, and logs a failed readiness announcement', async () => {
    const endpoint = new EdgeEndpoint()
    const runtime = new DesktopHostRuntime(makeRuntimeContext(), endpoint)
    runtime.start()
    runtime.start()
    await vi.waitFor(() => {
      expect(endpoint.sent.filter(message => message.type === 'ready')).toHaveLength(1)
    })
    expect(endpoint.listenerCount('message')).toBe(1)
    await runtime.dispose()

    const unstarted = new DesktopHostRuntime(makeRuntimeContext(), new EdgeEndpoint())
    await expect(unstarted.dispose()).resolves.toBeUndefined()

    const loader = Promise.reject(new Error('loader did not settle'))
    const failingEndpoint = new EdgeEndpoint()
    const failingCtx = makeRuntimeContext({ loaderReady: loader })
    const logged = vi.spyOn(failingCtx.logger, 'error').mockImplementation(() => {})
    const failing = new DesktopHostRuntime(failingCtx, failingEndpoint)
    failing.start()
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('ready announcement failed'))
    })
    await failing.dispose()
  })

  it('logs a readiness announcement failure when a client bundle path is missing', async () => {
    const endpoint = new EdgeEndpoint()
    const ctx = makeRuntimeContext({ clientPath: () => undefined })
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const runtime = new DesktopHostRuntime(ctx, endpoint)
    runtime.start()
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('ready announcement failed'))
    })
    await runtime.dispose()
  })

  it('runs a host subscription and accepts early stream acknowledgements as credits', async () => {
    const endpoint = new EdgeEndpoint()
    const gate = Promise.withResolvers<undefined>()
    const mux = async function *(): AsyncGenerator<RpcRequest<MuxFrame>> {
      await gate.promise
      yield muxFrame('mux-1')
      yield muxFrame('mux-2')
    }
    const runtime = new DesktopHostRuntime(makeRuntimeContext({ muxFrames: mux }), endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })

    endpoint.receive({ type: 'subscribe', id: 'stream-1', stream: 'mux' })
    await vi.waitFor(() => {
      expect(endpoint.sent.some(message => message.type === 'stream-open' && message.id === 'stream-1')).toBe(true)
    })
    endpoint.receive({ type: 'stream-ack', id: 'stream-1' })
    endpoint.receive({ type: 'stream-ack', id: 'stream-1' })
    gate.resolve(undefined)
    await vi.waitFor(() => {
      expect(endpoint.sent.filter(message => message.type === 'stream-message' && message.id === 'stream-1')).toHaveLength(2)
      expect(endpoint.sent.some(message => message.type === 'stream-end' && message.id === 'stream-1')).toBe(true)
    })
    await runtime.dispose()

    const hostEndpoint = new EdgeEndpoint()
    const hostRuntime = new DesktopHostRuntime(makeRuntimeContext({
      hostFrames: () => frames<HostFrame>([hostFrame('host-1')]),
    }), hostEndpoint)
    hostRuntime.start()
    await vi.waitFor(() => { expect(hostEndpoint.sent[0]?.type).toBe('ready') })
    hostEndpoint.receive({ type: 'subscribe', id: 'host-stream', stream: 'host' })
    await vi.waitFor(() => {
      expect(hostEndpoint.sent.some(message => message.type === 'stream-open' && message.id === 'host-stream')).toBe(true)
    })
    hostEndpoint.receive({ type: 'stream-ack', id: 'host-stream' })
    await vi.waitFor(() => {
      expect(hostEndpoint.sent.some(message => message.type === 'stream-end' && message.id === 'host-stream')).toBe(true)
    })
    await hostRuntime.dispose()
  })

  it('fails an ack waiter through subscription cancellation and through a pre-aborted pump', async () => {
    const endpoint = new EdgeEndpoint()
    const runtime = new DesktopHostRuntime(makeRuntimeContext({
      muxFrames: () => frames<MuxFrame>([muxFrame('mux-1')]),
    }), endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })

    endpoint.receive({ type: 'subscribe', id: 'waiter', stream: 'mux' })
    await vi.waitFor(() => {
      expect(endpoint.sent.some(message => message.type === 'stream-message' && message.id === 'waiter')).toBe(true)
    })
    endpoint.receive({ type: 'cancel-subscription', id: 'waiter' })
    await vi.waitFor(() => {
      expect(endpoint.sent.some(message => message.type === 'stream-end' && message.id === 'waiter')).toBe(true)
    })
    await runtime.dispose()

    const preAbortedEndpoint = new EdgeEndpoint()
    preAbortedEndpoint.onSend = (message) => {
      if (message.type === 'stream-open') {
        preAbortedEndpoint.receive({ type: 'cancel-subscription', id: message.id })
      }
    }
    const preAborted = new DesktopHostRuntime(makeRuntimeContext({
      muxFrames: () => frames<MuxFrame>([muxFrame('mux-1')]),
    }), preAbortedEndpoint)
    preAborted.start()
    await vi.waitFor(() => { expect(preAbortedEndpoint.sent[0]?.type).toBe('ready') })
    preAbortedEndpoint.receive({ type: 'subscribe', id: 'pre-aborted', stream: 'mux' })
    await vi.waitFor(() => {
      expect(preAbortedEndpoint.sent.some(message => message.type === 'stream-end' && message.id === 'pre-aborted')).toBe(true)
    })
    await preAborted.dispose()
  })
  it('aborts in-flight requests and subscriptions during disposal', async () => {
    const endpoint = new EdgeEndpoint()
    endpoint.blocked.set('stream-message', () => {})
    const ctx = makeRuntimeContext({
      fetch: request => new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
      }),
      muxFrames: () => frames<MuxFrame>([muxFrame('mux-1')]),
    })
    const runtime = new DesktopHostRuntime(ctx, endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })

    endpoint.receive({
      type: 'request', id: 'in-flight', url: 'dsh://app/api/session.list', method: 'GET', headers: [],
    })
    endpoint.receive({ type: 'subscribe', id: 'in-flight-stream', stream: 'mux' })
    await vi.waitFor(() => {
      expect(endpoint.sent.some(message => message.type === 'stream-message' && message.id === 'in-flight-stream')).toBe(true)
    })

    endpoint.release('stream-message')
    await Promise.resolve()
    await Promise.resolve()
    await runtime.dispose()
    endpoint.blocked.delete('stream-message')
  })



  it('reports source errors and delivery failures from each stream teardown branch', async () => {
    const endpoint = new EdgeEndpoint()
    const ctx = makeRuntimeContext({
      muxFrames: () => ({ async *[Symbol.asyncIterator]() { throw new Error('source broke') } } as AsyncIterable<RpcRequest<MuxFrame>>),
      hostFrames: () => ({ async *[Symbol.asyncIterator]() { throw 'plain text failure' } } as AsyncIterable<RpcRequest<HostFrame>>),
    })
    const runtime = new DesktopHostRuntime(ctx, endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })
    endpoint.receive({ type: 'subscribe', id: 'mux-error', stream: 'mux' })
    endpoint.receive({ type: 'subscribe', id: 'host-error', stream: 'host' })
    await vi.waitFor(() => {
      expect(endpoint.sent).toContainEqual({ type: 'stream-error', id: 'mux-error', message: 'source broke' })
      expect(endpoint.sent).toContainEqual({ type: 'stream-error', id: 'host-error', message: 'plain text failure' })
    })
    await runtime.dispose()

    const errorEndpoint = new EdgeEndpoint()
    errorEndpoint.callbackFailures.add('stream-error')
    const errorCtx = makeRuntimeContext({
      muxFrames: () => ({ async *[Symbol.asyncIterator]() { throw new Error('source broke') } } as AsyncIterable<RpcRequest<MuxFrame>>),
    })
    const logged = vi.spyOn(errorCtx.logger, 'error').mockImplementation(() => {})
    const errorRuntime = new DesktopHostRuntime(errorCtx, errorEndpoint)
    errorRuntime.start()
    await vi.waitFor(() => { expect(errorEndpoint.sent[0]?.type).toBe('ready') })
    errorEndpoint.receive({ type: 'subscribe', id: 'stream-error-send', stream: 'mux' })
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('stream error delivery failed'))
    })
    await errorRuntime.dispose()

    const endEndpoint = new EdgeEndpoint()
    endEndpoint.callbackFailures.add('stream-end')
    const endCtx = makeRuntimeContext({ muxFrames: () => frames<MuxFrame>([]) })
    const endLogged = vi.spyOn(endCtx.logger, 'error').mockImplementation(() => {})
    const endRuntime = new DesktopHostRuntime(endCtx, endEndpoint)
    endRuntime.start()
    await vi.waitFor(() => { expect(endEndpoint.sent[0]?.type).toBe('ready') })
    endEndpoint.receive({ type: 'subscribe', id: 'end-send', stream: 'mux' })
    await vi.waitFor(() => {
      expect(endLogged).toHaveBeenCalledWith(expect.stringContaining('stream end delivery failed'))
    })
    await endRuntime.dispose()
  })

  it('logs a subscription rejection delivery failure', async () => {
    const endpoint = new EdgeEndpoint()
    endpoint.callbackFailures.add('stream-error')
    const ctx = makeRuntimeContext()
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const runtime = new DesktopHostRuntime(ctx, endpoint)
    runtime.start()
    await vi.waitFor(() => { expect(endpoint.sent[0]?.type).toBe('ready') })
    endpoint.receive({ type: 'subscribe', id: 'duplicate', stream: 'mux' })
    endpoint.receive({ type: 'subscribe', id: 'duplicate', stream: 'host' })
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('subscription rejection delivery failed'))
    })
    await runtime.dispose()
  })

  it('reports disposal cancellation failures and ignores late native-request send failures after abort', async () => {
    const ctx = new Context()
    const endpoint = new EdgeEndpoint()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const actions = new DesktopNativeActions(ctx, endpoint)

    const disposingPending = actions.open('/workspace/dispose.txt', new AbortController().signal)
    const disposingRequest = endpoint.sent.at(-1)
    if (disposingRequest?.type !== 'native-request') throw new Error('native request missing')
    endpoint.callbackFailures.add('cancel-native-request')
    const disposing = actions.dispose()
    await expect(disposingPending).rejects.toThrow('desktop native actions disposed')
    await disposing
    expect(error).toHaveBeenCalledWith('[desktop-app] native cancellation delivery failed:', expect.any(Error))
    endpoint.callbackFailures.delete('cancel-native-request')
    error.mockRestore()

    const lateEndpoint = new EdgeEndpoint()
    lateEndpoint.blocked.set('native-request', () => {})
    const lateActions = new DesktopNativeActions(new Context(), lateEndpoint)
    const abort = new AbortController()
    const late = lateActions.open('/workspace/late.txt', abort.signal)
    abort.abort(new Error('renderer disconnected'))
    await expect(late).rejects.toThrow('renderer disconnected')
    lateEndpoint.releaseWith('native-request', new Error('late native-request send failure'))
    await Promise.resolve()
    await lateActions.dispose()
  })


  it('rejects native requests before send, after disposal, and through every endpoint failure mode', async () => {
    const ctx = new Context()
    const endpoint = new EdgeEndpoint()
    const actions = new DesktopNativeActions(ctx, endpoint)

    const aborted = new AbortController()
    aborted.abort('plain reason')

    await expect(actions.open('/workspace/a.txt', aborted.signal)).rejects.toThrow('plain reason')

    endpoint.callbackFailures.add('native-request')
    await expect(pickThrough(actions, new AbortController().signal)).rejects.toThrow('callback native-request')
    endpoint.callbackFailures.delete('native-request')

    endpoint.throwOn.add('native-request')
    await expect(pickThrough(actions, new AbortController().signal)).rejects.toThrow('thrown native-request')
    endpoint.throwOn.delete('native-request')

    endpoint.doubleCallbacks.add('native-request')
    const doubled = pickThrough(actions, new AbortController().signal)
    const doubledRequest = endpoint.sent.at(-1)
    if (doubledRequest?.type !== 'native-request') throw new Error('native request missing')
    endpoint.receive({
      type: 'native-response',
      id: doubledRequest.id,
      result: { ok: true, value: { type: 'pick-directory', path: null } },
    })
    await expect(doubled).resolves.toBeNull()
    endpoint.doubleCallbacks.delete('native-request')

    endpoint.connected = false
    await expect(pickThrough(actions, new AbortController().signal)).rejects.toThrow('child IPC channel is closed')
    endpoint.connected = true

    await actions.dispose()
    await expect(actions.dispose()).resolves.toBeUndefined()
    await expect(actions.open('/workspace/a.txt', new AbortController().signal)).rejects.toThrow('desktop native actions disposed')
    await expect(actions.open('/workspace/a.txt', aborted.signal)).rejects.toThrow('desktop native actions disposed')
  })

  it('ignores malformed native responses for unknown ids and logs cancellation delivery failures', async () => {
    const ctx = new Context()
    const endpoint = new EdgeEndpoint()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const actions = new DesktopNativeActions(ctx, endpoint)

    endpoint.receive({
      type: 'native-response',
      id: 'unknown',
      result: { ok: true, value: { type: 'pick-directory', path: 'relative/workspace' } },
    })
    endpoint.receive({
      type: 'native-response',
      id: 42,
      result: { ok: true, value: { type: 'pick-directory', path: null } },
    })
    await Promise.resolve()

    const abort = new AbortController()
    const pending = actions.open('/workspace/a.txt', abort.signal)
    const request = endpoint.sent.at(-1)
    if (request?.type !== 'native-request') throw new Error('native request missing')
    endpoint.callbackFailures.add('cancel-native-request')
    abort.abort(new Error('renderer disconnected'))
    await expect(pending).rejects.toThrow('renderer disconnected')
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith('[desktop-app] native cancellation delivery failed:', expect.any(Error))
    })
    endpoint.callbackFailures.delete('cancel-native-request')

    const cancelled = actions.open('/workspace/b.txt', new AbortController().signal)
    const cancelledRequest = endpoint.sent.at(-1)
    if (cancelledRequest?.type !== 'native-request') throw new Error('native request missing')
    endpoint.receive({
      type: 'native-response',
      id: cancelledRequest.id,
      result: { ok: false, error: { code: 'unknown-code', message: 'bad code' } },
    })
    await expect(cancelled).rejects.toThrow(/malformed native response/)

    await actions.dispose()
    error.mockRestore()
  })

  it('settles a mismatched pick response and a successful cancellation after disposal', async () => {
    const ctx = new Context()
    const endpoint = new EdgeEndpoint()
    const actions = new DesktopNativeActions(ctx, endpoint)

    const capability = actions.capability()
    if (capability.kind !== 'native') throw new Error('native capability missing')
    const picked = capability.pick(new AbortController().signal)
    const request = endpoint.sent.at(-1)
    if (request?.type !== 'native-request') throw new Error('pick request missing')
    endpoint.receive({
      type: 'native-response',
      id: request.id,
      result: { ok: true, value: { type: 'open-path', opened: true } },
    })
    await expect(picked).rejects.toThrow(/malformed native response/)

    const disposing = actions.dispose()
    await disposing
    await actions.dispose()
  })

  it('mounts the runtime through apply for both apiProxy timings and rejects a disconnected endpoint', async () => {
    const saved = internals.endpoint
    try {
      const disconnected = new EdgeEndpoint()
      disconnected.connected = false
      internals.endpoint = disconnected
      expect(() => { apply(new Context()) }).toThrow('DSH runtime must be launched with an IPC channel')

      const directEndpoint = new EdgeEndpoint()
      internals.endpoint = directEndpoint
      const directCtx = makeRuntimeContext()
      apply(directCtx)
      await vi.waitFor(() => { expect(directEndpoint.sent[0]?.type).toBe('ready') })
      expect(directCtx.get('nativePathOpener')).toBeDefined()
      await directCtx.fiber.dispose()
      expect(directEndpoint.listenerCount('message')).toBe(0)

      const injectedEndpoint = new EdgeEndpoint()
      internals.endpoint = injectedEndpoint
      const injectedCtx = new Context()
      injectedCtx.provide('loader', { await: () => Promise.resolve() })
      injectedCtx.provide('clientModules', {
        graph: () => ({
          rev: 'desktop-test',
          entries: [{ id: '@fixture/client', url: '/plugins/client.js', rev: 'one' }],
        }),
        clientPath: () => '/fixture/client.js',
      } as unknown as ClientModuleRegistry)
      injectedCtx.provide('connection', {
        rpc: {},
        createSharedFetchHandler: () => ({
          fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
        }),
      } as unknown as HostConnectionHandle)
      apply(injectedCtx)
      injectedCtx.provide('apiProxy', {
        sessions: {
          list: (request: { rpcId: ReturnType<typeof RpcId> }) => Promise.resolve({
            rpcId: request.rpcId,
            result: { ok: true, value: { items: [] } },
          }),
        },
        events: {
          mux: () => frames<MuxFrame>([]),
          host: () => frames<HostFrame>([]),
        },
      } as unknown as ApiProxy)
      await vi.waitFor(() => { expect(injectedEndpoint.sent[0]?.type).toBe('ready') })
      await injectedCtx.fiber.dispose()
      expect(injectedEndpoint.listenerCount('message')).toBe(0)
    } finally {
      internals.endpoint = saved
    }
  })
})
