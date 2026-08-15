/** Desktop product glue running inside the dedicated DSH child process. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { RpcId, type HostFrame, type MuxFrame, type RpcRequest, type ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-modules'
import type { DesktopChildMessage, DesktopParentMessage } from './protocol.ts'

export type {
  DesktopChildMessage, DesktopChildRequest, DesktopClientBundle, DesktopParentMessage,
} from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-app'

/** Services needed before the child can announce a complete product composition. */
export const inject = ['apiProxy', 'connection', 'clientModules', 'loader']

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

function parseParentMessage(value: unknown): DesktopParentMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || !isId(value.id)) return undefined
  switch (value.type) {
    case 'cancel-request':
    case 'cancel-subscription':
      return { type: value.type, id: value.id }
    case 'subscribe':
      return value.stream === 'mux' || value.stream === 'host'
        ? { type: 'subscribe', id: value.id, stream: value.stream }
        : undefined
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
  }

  private send(message: DesktopChildMessage): Promise<void> {
    return new Promise((resolveSend, reject) => {
      if (!this.endpoint.connected) {
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
        this.endpoint.send(message, settle)
      } catch (error: unknown) {
        settle(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private sendDetached(message: DesktopChildMessage): void {
    void this.send(message).catch((error: unknown) => {
      this.ctx.logger.error(`desktop-app: notification delivery failed: ${String(error)}`)
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
    await this.send({ type: 'ready', graph, bundles })
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
      await this.send(reply)
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
        await this.send({ type: 'stream-error', id, message })
        if (controller === undefined) await this.send({ type: 'stream-end', id })
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
      await this.send({ type: 'stream-open', id })
      for await (const frame of frames) {
        await this.send({ type: 'stream-message', id, message: fullFrame(frame) })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        try {
          await this.send({
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
      if (this.subscriptionStreams.get(stream) === id) this.subscriptionStreams.delete(stream)
      try {
        await this.send({ type: 'stream-end', id })
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
  const runtime = new DesktopHostRuntime(ctx, internals.endpoint)
  ctx.effect(() => {
    runtime.start()
    return () => runtime.dispose()
  }, 'desktop-app: child IPC runtime')
}
