/** Desktop product glue running inside the dedicated DSH child process. */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DirectoryPicker, type DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { RpcId, type HostFrame, type MuxFrame, type RpcRequest, type ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler, type NativePathOpener } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-modules'
import type {
  DesktopChildMessage,
  DesktopNativeErrorCode,
  DesktopNativeRequest,
  DesktopNativeResult,
  DesktopNativeValue,
  DesktopParentMessage,
} from './protocol.ts'

export type {
  DesktopChildMessage, DesktopChildRequest, DesktopClientBundle, DesktopNativeErrorCode,
  DesktopNativeRequest, DesktopNativeResult, DesktopNativeValue, DesktopParentMessage,
} from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-app'

/** Services needed before the child can announce a complete product composition. */
export const inject = ['connection', 'clientModules', 'loader']

/** Process-like IPC endpoint; tests substitute a deterministic in-memory peer. */
export interface DesktopChildEndpoint {
  readonly connected: boolean
  send(message: DesktopChildMessage, callback?: (error: Error | null) => void): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  off(event: 'message', listener: (message: unknown) => void): this
}

type Frame = MuxFrame | HostFrame

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isAbsolutePath(value: string): boolean {
  return value !== '' && !value.includes('\0') && isAbsolute(value)
}

function isDesktopAppUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh:'
      && url.hostname === 'app'
      && url.port === ''
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

const NATIVE_ERROR_CODES = new Set([
  'cancelled', 'invalid-request', 'invalid-path', 'unavailable', 'failed',
])

function parseNativeValue(value: unknown): DesktopNativeValue | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  if (value.type === 'pick-directory') {
    return value.path === null || typeof value.path === 'string' && isAbsolutePath(value.path)
      ? { type: 'pick-directory', path: value.path }
      : undefined
  }
  if (value.type === 'open-path' && value.opened === true) {
    return { type: 'open-path', opened: true }
  }
  return undefined
}

function parseNativeResult(value: unknown): DesktopNativeResult | undefined {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return undefined
  if (value.ok) {
    const parsed = parseNativeValue(value.value)
    return parsed === undefined ? undefined : { ok: true, value: parsed }
  }
  if (!isRecord(value.error) || typeof value.error.code !== 'string'
    || !NATIVE_ERROR_CODES.has(value.error.code)
    || typeof value.error.message !== 'string') return undefined
  return {
    ok: false,
    error: {
      code: value.error.code as DesktopNativeErrorCode,
      message: value.error.message,
    },
  }
}

function parseParentMessage(value: unknown): DesktopParentMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || !isId(value.id)) return undefined
  switch (value.type) {
    case 'cancel-request':
    case 'cancel-subscription':
    case 'stream-ack':
      return { type: value.type, id: value.id }
    case 'subscribe':
      return value.stream === 'mux' || value.stream === 'host'
        ? { type: 'subscribe', id: value.id, stream: value.stream }
        : undefined
    case 'native-response': {
      const result = parseNativeResult(value.result)
      return result === undefined ? undefined : { type: 'native-response', id: value.id, result }
    }
    case 'request': {
      if (typeof value.url !== 'string' || !isDesktopAppUrl(value.url)
        || typeof value.method !== 'string' || value.method.length === 0
        || !Array.isArray(value.headers)) return undefined
      const headers: Array<readonly [string, string]> = []
      for (const header of value.headers) {
        if (!Array.isArray(header) || header.length !== 2
          || typeof header[0] !== 'string' || typeof header[1] !== 'string') return undefined
        headers.push([header[0], header[1]])
      }
      if (value.body !== undefined && typeof value.body !== 'string') return undefined
      return {
        type: 'request',
        id: value.id,
        url: value.url,
        method: value.method,
        headers,
        ...(value.body === undefined ? {} : { body: value.body }),
      }
    }
    default:
      return undefined
  }
}

interface PendingNativeAction {
  readonly request: DesktopNativeRequest
  readonly signal: AbortSignal
  readonly onAbort: () => void
  resolve(value: DesktopNativeValue): void
  reject(error: Error): void
}

function nativeValueMatches(request: DesktopNativeRequest, value: DesktopNativeValue): boolean {
  return request.type === value.type
}

/** Desktop product adapter: the child delegates its two system actions back to Electron main. */
export class DesktopNativeActions extends DirectoryPicker implements NativePathOpener {
  private readonly pending = new Map<string, PendingNativeAction>()
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    pick: signal => this.pick(signal),
  }
  private disposed = false

  constructor(ctx: Context, private readonly endpoint: DesktopChildEndpoint) {
    super(ctx)
    ctx.provide('nativePathOpener', this)
    endpoint.on('message', this.onMessage)
  }

  /** Stable native directory-picker capability consumed by ApiProxy. */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }

  /** Electron main is the visible desktop for this product assembly. */
  available(): boolean {
    return !this.disposed && this.endpoint.connected
  }

  /** Ask Electron main to open one Host-resolved path. */
  async open(path: string, signal: AbortSignal): Promise<void> {
    const value = await this.request({ type: 'open-path', path }, signal)
    if (value.type !== 'open-path') throw new Error('desktop-app: malformed native response')
  }

  /** Stop listening and settle every reverse request owned by this assembly. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.endpoint.off('message', this.onMessage)
    const cancellations: Promise<void>[] = []
    for (const [id, pending] of this.pending) {
      pending.signal.removeEventListener('abort', pending.onAbort)
      cancellations.push(sendChildMessage(this.endpoint, { type: 'cancel-native-request', id }).catch((error: unknown) => {
        console.error('[desktop-app] native cancellation delivery failed:', error)
      }))
      pending.reject(new Error('desktop native actions disposed'))
      this.pending.delete(id)
    }
    await Promise.all(cancellations)
  }

  private async pick(signal: AbortSignal): Promise<string | null> {
    const value = await this.request({ type: 'pick-directory' }, signal)
    if (value.type !== 'pick-directory') throw new Error('desktop-app: malformed native response')
    return value.path
  }

  private request(request: DesktopNativeRequest, signal: AbortSignal): Promise<DesktopNativeValue> {
    if (this.disposed) return Promise.reject(new Error('desktop native actions disposed'))
    if (signal.aborted) return Promise.reject(errorFrom(signal.reason))
    const id = randomUUID()
    const result = Promise.withResolvers<DesktopNativeValue>()
    const onAbort = (): void => {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      signal.removeEventListener('abort', onAbort)
      this.sendDetached({ type: 'cancel-native-request', id })
      result.reject(errorFrom(signal.reason))
    }
    this.pending.set(id, { request, signal, onAbort, resolve: result.resolve, reject: result.reject })
    signal.addEventListener('abort', onAbort, { once: true })
    void sendChildMessage(this.endpoint, { type: 'native-request', id, request }).catch((error: unknown) => {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      signal.removeEventListener('abort', onAbort)
      result.reject(errorFrom(error))
    })
    return result.promise
  }

  private readonly onMessage = (value: unknown): void => {
    const message = parseParentMessage(value)
    if (message?.type !== 'native-response') {
      if (isRecord(value) && value.type === 'native-response' && isId(value.id)) {
        const pending = this.pending.get(value.id)
        if (pending !== undefined) this.settleFailure(value.id, pending, new Error('desktop-app: malformed native response'))
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    if (!message.result.ok) {
      this.settleFailure(message.id, pending, new Error(message.result.error.message))
      return
    }
    if (!nativeValueMatches(pending.request, message.result.value)) {
      this.settleFailure(message.id, pending, new Error('desktop-app: malformed native response'))
      return
    }
    this.pending.delete(message.id)
    pending.signal.removeEventListener('abort', pending.onAbort)
    pending.resolve(message.result.value)
  }

  private settleFailure(id: string, pending: PendingNativeAction, error: Error): void {
    this.pending.delete(id)
    pending.signal.removeEventListener('abort', pending.onAbort)
    pending.reject(error)
  }

  private sendDetached(message: DesktopChildMessage): void {
    void sendChildMessage(this.endpoint, message).catch((error: unknown) => {
      console.error('[desktop-app] native cancellation delivery failed:', error)
    })
  }
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function sendChildMessage(endpoint: DesktopChildEndpoint, message: DesktopChildMessage): Promise<void> {
  return new Promise((resolveSend, reject) => {
    if (!endpoint.connected) {
      reject(new Error('desktop-app: child IPC channel is closed'))
      return
    }
    let settled = false
    const settle = (error: Error | null): void => {
      if (settled) return
      settled = true
      if (error === null) resolveSend()
      else reject(new Error(`desktop-app: child IPC send failed: ${error.message}`))
    }
    try {
      // The callback is the drain signal when send() returns false; awaiting it
      // retains at most one child-IPC notification per logical pump.
      endpoint.send(message, settle)
    } catch (error: unknown) {
      settle(errorFrom(error))
    }
  })
}

function fullFrame(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

/** Owns request cancellation and stream pumps for one child-process lifetime. */
export class DesktopHostRuntime {
  private readonly requestAborts = new Map<string, AbortController>()
  private readonly subscriptions = new Map<string, AbortController>()
  private readonly subscriptionStreams = new Map<'mux' | 'host', string>()
  /** Per-pump frame-ack credits; an ack may legally arrive before its waiter. */
  private readonly streamAckState = new Map<string, { credits: number; waiter: (() => void) | undefined }>()
  private readonly requests = new Set<Promise<void>>()
  private readonly pumps = new Set<Promise<void>>()
  private readyTask: Promise<void> | undefined
  /** The shared `/api` dispatcher this carrier serves unary requests through. */
  private readonly fetchHandler: { fetch(request: Request): Promise<Response> }
  private started = false

  constructor(
    private readonly ctx: Context,
    private readonly endpoint: DesktopChildEndpoint,
  ) {
    this.fetchHandler = ctx.connection.createSharedFetchHandler('/api', toFetchHandler(ctx.apiProxy))
  }

  /** Start accepting messages and announce readiness after Loader settlement. */
  start(): void {
    if (this.started) return
    this.started = true
    this.endpoint.on('message', this.onMessage)
    this.readyTask = this.announceReady().catch((error: unknown) => {
      this.ctx.logger.error(`desktop-app: ready announcement failed: ${String(error)}`)
    })
  }

  /** Stop every request/stream and wait for source iterators to release. */
  async dispose(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.endpoint.off('message', this.onMessage)
    for (const controller of this.requestAborts.values()) controller.abort()
    for (const controller of this.subscriptions.values()) controller.abort()
    await Promise.all([...this.requests, ...this.pumps, ...(this.readyTask === undefined ? [] : [this.readyTask])])
    this.readyTask = undefined
    this.requestAborts.clear()
    this.subscriptions.clear()
    this.subscriptionStreams.clear()
    this.streamAckState.clear()
  }

  private sendDetached(message: DesktopChildMessage): void {
    void sendChildMessage(this.endpoint, message).catch((error: unknown) => {
      this.ctx.logger.error(`desktop-app: notification delivery failed: ${String(error)}`)
    })
  }

  /** Wait for Electron main's frame acknowledgement, or fail on cancellation. */
  private waitForStreamAck(id: string, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return Promise.reject(errorFrom(controller.signal.reason))
    const state = this.streamAckState.get(id) ?? { credits: 0, waiter: undefined }
    if (state.credits > 0) {
      state.credits -= 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        if (state.waiter !== undefined) state.waiter = undefined
        reject(errorFrom(controller.signal.reason))
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      state.waiter = () => {
        controller.signal.removeEventListener('abort', onAbort)
        resolve()
      }
      this.streamAckState.set(id, state)
    })
  }

  private isStarted(): boolean {
    return this.started
  }

  private async announceReady(): Promise<void> {
    await this.ctx.loader.await()
    if (!this.isStarted()) return
    const graph = this.ctx.clientModules.graph()
    const bundles = graph.entries.map((entry) => {
      const path = this.ctx.clientModules.clientPath(entry.id)
      if (path === undefined) throw new Error(`desktop-app: missing client bundle path for ${entry.id}`)
      return { id: entry.id, path }
    })
    await sendChildMessage(this.endpoint, { type: 'ready', graph, bundles })
  }

  private readonly onMessage = (value: unknown): void => {
    const message = parseParentMessage(value)
    if (message === undefined) {
      this.ctx.logger.warn('desktop-app: dropped malformed parent IPC message')
      return
    }
    switch (message.type) {
      case 'request':
        {
          const request = this.handleRequest(message)
          this.requests.add(request)
          void request.finally(() => { this.requests.delete(request) })
        }
        return
      case 'cancel-request':
        this.requestAborts.get(message.id)?.abort()
        return
      case 'subscribe':
        this.openSubscription(message.id, message.stream)
        return
      case 'cancel-subscription':
        this.subscriptions.get(message.id)?.abort()
        return
      case 'stream-ack':
        {
          // An acknowledgement for a subscription whose pump is gone (a late
          // terminal ack) must not mint a retained credit entry.
          if (!this.subscriptions.has(message.id)) return
          const state = this.streamAckState.get(message.id)
          if (state === undefined) {
            this.streamAckState.set(message.id, { credits: 1, waiter: undefined })
          } else if (state.waiter !== undefined) {
            const waiter = state.waiter
            state.waiter = undefined
            waiter()
          } else {
            state.credits += 1
          }
        }
        return
      case 'native-response':
        // DesktopNativeActions owns reverse-response correlation on the same endpoint.
        return
      default:
        message satisfies never
    }
  }

  private async handleRequest(message: Extract<DesktopParentMessage, { type: 'request' }>): Promise<void> {
    if (this.requestAborts.has(message.id)) {
      this.sendDetached({ type: 'request-error', id: message.id, message: 'duplicate request id' })
      return
    }
    const controller = new AbortController()
    this.requestAborts.set(message.id, controller)
    let reply: Extract<DesktopChildMessage, { type: 'response' | 'request-error' }>
    try {
      const source = new URL(message.url)
      const request = new Request(`http://127.0.0.1${source.pathname}${source.search}`, {
        method: message.method,
        headers: message.headers.map(([name, value]) => [name, value]),
        ...(message.body === undefined ? {} : { body: message.body }),
        signal: controller.signal,
      })
      const response = await this.fetchHandler.fetch(request)
      reply = {
        type: 'response',
        id: message.id,
        status: response.status,
        headers: [...response.headers.entries()],
        body: await response.text(),
      }
    } catch (error) {
      reply = { type: 'request-error', id: message.id, message: String(error) }
    } finally {
      this.requestAborts.delete(message.id)
    }
    try {
      await sendChildMessage(this.endpoint, reply)
    } catch (error: unknown) {
      this.ctx.logger.error(`desktop-app: request reply delivery failed: ${String(error)}`)
    }
  }

  private openSubscription(id: string, stream: 'mux' | 'host'): void {
    if (this.subscriptions.has(id)) {
      this.rejectSubscription(id, 'duplicate subscription id')
      return
    }
    if (this.subscriptionStreams.has(stream)) {
      this.rejectSubscription(id, `desktop-app: duplicate ${stream} subscription`)
      return
    }
    const controller = new AbortController()
    this.subscriptions.set(id, controller)
    this.subscriptionStreams.set(stream, id)
    const pump = stream === 'mux'
      ? this.pump(id, stream, this.ctx.apiProxy.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, controller.signal), controller)
      : this.pump(id, stream, this.ctx.apiProxy.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, controller.signal), controller)
    this.pumps.add(pump)
    void pump.finally(() => { this.pumps.delete(pump) })
  }

  private rejectSubscription(id: string, message: string): void {
    const controller = this.subscriptions.get(id)
    if (controller !== undefined) controller.abort()
    const rejection = (async () => {
      try {
        await sendChildMessage(this.endpoint, { type: 'stream-error', id, message })
        if (controller === undefined) await sendChildMessage(this.endpoint, { type: 'stream-end', id })
      } catch (error: unknown) {
        this.ctx.logger.error(`desktop-app: subscription rejection delivery failed: ${String(error)}`)
      }
    })()
    this.pumps.add(rejection)
    void rejection.finally(() => { this.pumps.delete(rejection) })
  }

  private async pump<F extends Frame>(
    id: string,
    stream: 'mux' | 'host',
    frames: AsyncIterable<RpcRequest<F>>,
    controller: AbortController,
  ): Promise<void> {
    try {
      await sendChildMessage(this.endpoint, { type: 'stream-open', id })
      for await (const frame of frames) {
        await sendChildMessage(this.endpoint, { type: 'stream-message', id, message: fullFrame(frame) })
        // End-to-end backpressure: Electron main acknowledges each frame only
        // after the renderer's relay accepted it, so a slow consumer paces the
        // ordered source instead of overflowing a bounded relay queue.
        await this.waitForStreamAck(id, controller)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        try {
          await sendChildMessage(this.endpoint, {
            type: 'stream-error',
            id,
            message: error instanceof Error ? error.message : String(error),
          })
        } catch (sendError: unknown) {
          this.ctx.logger.error(`desktop-app: stream error delivery failed: ${String(sendError)}`)
        }
      }
    } finally {
      controller.abort()
      this.subscriptions.delete(id)
      this.streamAckState.delete(id)
      if (this.subscriptionStreams.get(stream) === id) this.subscriptionStreams.delete(stream)
      try {
        await sendChildMessage(this.endpoint, { type: 'stream-end', id })
      } catch (error: unknown) {
        this.ctx.logger.error(`desktop-app: stream end delivery failed: ${String(error)}`)
      }
    }
  }
}

/** Test seam for the process IPC endpoint; production uses the current child process. */
export const internals: { endpoint: DesktopChildEndpoint } = {
  endpoint: process as unknown as DesktopChildEndpoint,
}

/** Mount the dedicated-child desktop carrier. */
export function apply(ctx: Context): void {
  if (!internals.endpoint.connected) {
    throw new Error('desktop-app: DSH runtime must be launched with an IPC channel')
  }
  const actions = new DesktopNativeActions(ctx, internals.endpoint)
  ctx.effect(() => {
    return () => actions.dispose()
  }, 'desktop-app: native actions')
  const mountRuntime = (runtimeCtx: Context): void => {
    const apiProxy = runtimeCtx.get('apiProxy')
    if (apiProxy === undefined) throw new Error('desktop-app: apiProxy became unavailable during runtime mount')
    const runtime = new DesktopHostRuntime(runtimeCtx, internals.endpoint)
    runtimeCtx.effect(() => {
      runtime.start()
      return () => runtime.dispose()
    }, 'desktop-app: child IPC runtime')
  }
  if (ctx.get('apiProxy') === undefined) ctx.inject(['apiProxy'], mountRuntime)
  else mountRuntime(ctx)
}
