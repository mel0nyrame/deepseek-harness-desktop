/** Host half of the desktop-owned IPC connection provider. */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  HostConnectionService,
  type ConnectionChannelRegistrar,
} from '@deepseek-ai/dsh-client-connection'
import { RpcId, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type {
  ApiProxy,
  HostFrame,
  MuxFrame,
  RpcRequest,
  ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  parseDesktopParentMessage,
  type DesktopChildMessage,
  type DesktopParentMessage,
} from './protocol.js'

export type {
  DesktopCapabilityAction,
  DesktopCapabilityValue,
  DesktopChildMessage,
  DesktopParentMessage,
} from './protocol.js'
export {
  parseDesktopBridgeRequest,
  parseDesktopCapabilityRequest,
  parseDesktopCapabilityResponse,
  parseDesktopChildMessage,
  parseDesktopParentMessage,
} from './protocol.js'

/** Stable Host plugin name shared with the Client bundle row. */
export const name = 'desktop-connection'

/** This provider is the Host wire root; ApiProxy may resolve later. */
export const inject: string[] = []

/** Process-like endpoint owned by the dedicated DSH child. */
export interface DesktopChildEndpoint {
  readonly connected: boolean
  send(message: DesktopChildMessage, callback?: (error: Error | null) => void): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'disconnect', listener: () => void): this
  off(event: 'message', listener: (message: unknown) => void): this
  off(event: 'disconnect', listener: () => void): this
}

type Frame = MuxFrame | HostFrame

interface FetchHandler {
  fetch(request: Request): Promise<Response>
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function sendChildMessage(endpoint: DesktopChildEndpoint, message: DesktopChildMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!endpoint.connected) {
      reject(new Error('desktop connection: child IPC channel is closed'))
      return
    }
    let settled = false
    const settle = (error: Error | null): void => {
      if (settled) return
      settled = true
      if (error === null) resolve()
      else reject(new Error(`desktop connection: child IPC send failed: ${error.message}`))
    }
    try {
      endpoint.send(message, settle)
    } catch (error) {
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

class DesktopChannelRegistry implements ConnectionChannelRegistrar {
  private readonly handlers = new Map<string, FetchHandler>()

  register(channel: string, handler: FetchHandler): () => void {
    if (this.handlers.has(channel)) throw new Error(`desktop connection: duplicate channel ${JSON.stringify(channel)}`)
    this.handlers.set(channel, handler)
    return () => { this.handlers.delete(channel) }
  }

  handler(pathname: string): FetchHandler | undefined {
    for (const [channel, handler] of this.handlers) {
      if (pathname.startsWith(`${channel}/`)) return handler
    }
    return undefined
  }
}

/** Owns requests and stream pumps for one Host-process IPC lifetime. */
class DesktopHostConnection {
  private readonly requestAborts = new Map<string, AbortController>()
  private readonly subscriptions = new Map<string, AbortController>()
  private readonly subscriptionStreams = new Map<'mux' | 'host', string>()
  private readonly ackState = new Map<string, { credit: boolean; waiter: (() => void) | undefined }>()
  private readonly requests = new Set<Promise<void>>()
  private readonly pumps = new Set<Promise<void>>()
  private readonly apiHandler: FetchHandler
  private readonly channels: DesktopChannelRegistry
  private readonly api: ApiProxy
  private readonly endpoint: DesktopChildEndpoint
  private started = false
  private disposeTask: Promise<void> | undefined

  constructor(
    connection: HostConnectionService,
    channels: DesktopChannelRegistry,
    api: ApiProxy,
    endpoint: DesktopChildEndpoint,
  ) {
    this.channels = channels
    this.api = api
    this.endpoint = endpoint
    this.apiHandler = connection.createSharedFetchHandler('/api', toFetchHandler(api))
  }

  /** Start accepting validated IPC commands. */
  start(): void {
    if (this.started) return
    this.started = true
    this.endpoint.on('message', this.onMessage)
    this.endpoint.on('disconnect', this.onDisconnect)
    void this.send({ type: 'connection-ready' }).catch(error => {
      this.reportDeliveryFailure('readiness signal', error)
    })
  }

  /** Stop all work, detach endpoint listeners, and await source cleanup. */
  dispose(): Promise<void> {
    this.disposeTask ??= this.disposeNow()
    return this.disposeTask
  }

  private async disposeNow(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.endpoint.off('message', this.onMessage)
    this.endpoint.off('disconnect', this.onDisconnect)
    for (const controller of this.requestAborts.values()) controller.abort()
    for (const controller of this.subscriptions.values()) controller.abort()
    for (const state of this.ackState.values()) state.waiter?.()
    await Promise.all([...this.requests, ...this.pumps])
    this.requestAborts.clear()
    this.subscriptions.clear()
    this.subscriptionStreams.clear()
    this.ackState.clear()
  }

  private readonly onDisconnect = (): void => {
    void this.dispose()
  }

  private readonly onMessage = (value: unknown): void => {
    const message = parseDesktopParentMessage(value)
    if (message === undefined) {
      console.warn('[desktop-connection] dropped malformed parent IPC message')
      return
    }
    if (message.type === 'request') {
      const request = this.handleRequest(message)
      this.requests.add(request)
      void request.finally(() => { this.requests.delete(request) })
      return
    }
    if (message.type === 'cancel-request') {
      this.requestAborts.get(message.id)?.abort()
      return
    }
    if (message.type === 'subscribe') {
      this.openSubscription(message.id, message.stream)
      return
    }
    if (message.type === 'cancel-subscription') {
      this.subscriptions.get(message.id)?.abort()
      return
    }
    if (!this.subscriptions.has(message.id)) return
    const state = this.ackState.get(message.id)
    if (state?.waiter !== undefined) {
      const waiter = state.waiter
      state.waiter = undefined
      waiter()
    } else {
      this.ackState.set(message.id, { credit: true, waiter: undefined })
    }
  }

  private async handleRequest(message: Extract<DesktopParentMessage, { type: 'request' }>): Promise<void> {
    if (this.requestAborts.has(message.id)) {
      await this.send({ type: 'request-error', id: message.id, message: 'duplicate request id' })
        .catch(error => { this.reportDeliveryFailure('request rejection', error) })
      return
    }
    const controller = new AbortController()
    this.requestAborts.set(message.id, controller)
    let reply: Extract<DesktopChildMessage, { type: 'response' | 'request-error' }>
    try {
      const source = new URL(message.url)
      const handler = source.pathname.startsWith('/api/') ? this.apiHandler : this.channels.handler(source.pathname)
      if (handler === undefined) throw new Error(`no desktop connection channel owns ${source.pathname}`)
      const request = new Request(`http://127.0.0.1${source.pathname}${source.search}`, {
        method: message.method,
        headers: message.headers.map(([headerName, value]) => [headerName, value]),
        ...(message.body === undefined ? {} : { body: message.body }),
        signal: controller.signal,
      })
      const response = await handler.fetch(request)
      reply = {
        type: 'response', id: message.id, status: response.status,
        headers: [...response.headers.entries()], body: await response.text(),
      }
    } catch (error) {
      reply = { type: 'request-error', id: message.id, message: errorFrom(error).message }
    } finally {
      this.requestAborts.delete(message.id)
    }
    await this.send(reply).catch(error => { this.reportDeliveryFailure('request reply', error) })
  }

  private openSubscription(id: string, stream: 'mux' | 'host'): void {
    if (this.subscriptions.has(id) || this.subscriptionStreams.has(stream)) {
      void this.send({ type: 'stream-error', id, message: `duplicate ${stream} subscription` })
        .catch(error => { this.reportDeliveryFailure('subscription rejection', error) })
      return
    }
    const controller = new AbortController()
    this.subscriptions.set(id, controller)
    this.subscriptionStreams.set(stream, id)
    let frames: AsyncIterable<RpcRequest<Frame>>
    try {
      frames = stream === 'mux'
        ? this.api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, controller.signal)
        : this.api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, controller.signal)
    } catch (error) {
      controller.abort()
      this.subscriptions.delete(id)
      if (this.subscriptionStreams.get(stream) === id) this.subscriptionStreams.delete(stream)
      const rejection = this.rejectSubscription(id, error)
      this.pumps.add(rejection)
      void rejection.finally(() => { this.pumps.delete(rejection) })
      return
    }
    const pump = this.pump(id, stream, frames, controller)
    this.pumps.add(pump)
    void pump.finally(() => { this.pumps.delete(pump) })
  }

  private async rejectSubscription(id: string, error: unknown): Promise<void> {
    await this.send({ type: 'stream-error', id, message: errorFrom(error).message })
      .catch(sendError => { this.reportDeliveryFailure('subscription rejection', sendError) })
    await this.send({ type: 'stream-end', id })
      .catch(sendError => { this.reportDeliveryFailure('subscription end', sendError) })
  }

  private async pump(
    id: string,
    stream: 'mux' | 'host',
    frames: AsyncIterable<RpcRequest<Frame>>,
    controller: AbortController,
  ): Promise<void> {
    try {
      await this.send({ type: 'stream-open', id })
      await this.waitForAck(id, controller.signal)
      for await (const frame of frames) {
        await this.send({ type: 'stream-message', id, message: fullFrame(frame) })
        await this.waitForAck(id, controller.signal)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        await this.send({ type: 'stream-error', id, message: errorFrom(error).message })
          .catch(sendError => { this.reportDeliveryFailure('stream error', sendError) })
      }
    } finally {
      controller.abort()
      this.subscriptions.delete(id)
      this.ackState.delete(id)
      if (this.subscriptionStreams.get(stream) === id) this.subscriptionStreams.delete(stream)
      await this.send({ type: 'stream-end', id })
        .catch(error => { this.reportDeliveryFailure('stream end', error) })
    }
  }

  private waitForAck(id: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(errorFrom(signal.reason))
    const state = this.ackState.get(id) ?? { credit: false, waiter: undefined }
    if (state.credit) {
      state.credit = false
      this.ackState.set(id, state)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.ackState.delete(id)
        reject(errorFrom(signal.reason))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      state.waiter = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      this.ackState.set(id, state)
    })
  }

  private send(message: DesktopChildMessage): Promise<void> {
    return sendChildMessage(this.endpoint, message)
  }

  private reportDeliveryFailure(kind: string, error: unknown): void {
    if (this.endpoint.connected) {
      console.error(`[desktop-connection] ${kind} delivery failed:`, error)
    }
  }
}

/** Test seam for the child-process endpoint; production uses process IPC. */
export const internals: { endpoint: DesktopChildEndpoint; createContext(): Context } = {
  endpoint: process as unknown as DesktopChildEndpoint,
  createContext: () => new Context(),
}

/** Provide Host Connection immediately, then mount its ApiProxy carrier when available. */
export function apply(ctx: Context): void {
  if (!internals.endpoint.connected) throw new Error('desktop connection: Host must run with an IPC channel')
  const channels = new DesktopChannelRegistry()
  const connection = new HostConnectionService(ctx, [], channels)
  const mount = (runtimeCtx: Context): void => {
    const api = runtimeCtx.get('apiProxy')
    if (api === undefined) throw new Error('desktop connection: ApiProxy unavailable during mount')
    const runtime = new DesktopHostConnection(connection, channels, api, internals.endpoint)
    runtimeCtx.effect(() => {
      runtime.start()
      return () => runtime.dispose()
    }, 'desktop-connection: child IPC carrier')
  }
  if (ctx.get('apiProxy') === undefined) ctx.inject(['apiProxy'], mount)
  else mount(ctx)
}
