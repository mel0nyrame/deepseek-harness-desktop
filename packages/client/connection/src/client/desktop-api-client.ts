/** Electron preload carrier for the existing Client Connection protocol. */

import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from './api.ts'
import { AbstractApiClient } from './api.ts'

/** Request copied across the context-isolated preload boundary. */
export interface DesktopBridgeRequest {
  readonly id: string
  readonly url: string
  readonly method: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body?: string
}

/** Complete non-streaming response copied back through preload. */
export interface DesktopBridgeResponse {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly body: string
}

/** Logical downstream names shared with the Connection carrier contract. */
export type DesktopStream = 'mux' | 'host'

/** One stream lifecycle notification from Electron main. */
export type DesktopStreamEvent =
  | { readonly type: 'open'; readonly id: string }
  | { readonly type: 'message'; readonly id: string; readonly message: unknown }
  | { readonly type: 'end'; readonly id: string }
  | { readonly type: 'error'; readonly id: string; readonly message: string }

/** Narrow API exposed by the context-isolated preload script. */
export interface DesktopBridge {
  request(request: DesktopBridgeRequest): Promise<DesktopBridgeResponse>
  cancelRequest(id: string): void
  subscribe(id: string, stream: DesktopStream): void
  cancelSubscription(id: string): void
  /**
   * Signal that one delivered stream event has been observed: frames are
   * acknowledged only after the consumer takes them, while lifecycle events
   * (open/end/error) are acknowledged as soon as they arrive.
   */
  ackStream(id: string): void
  onStream(listener: (event: DesktopStreamEvent) => void): () => void
}

/** Maximum parsed frames retained for one renderer subscription. */
export const DESKTOP_STREAM_QUEUE_LIMIT = 256

type StreamItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' } | { kind: 'error'; error: Error }
type Parser<F> = { parse(value: unknown): F }

function requestBody(init: RequestInit | undefined): string | undefined {
  if (init?.body === undefined || init.body === null) return undefined
  if (typeof init.body !== 'string') {
    throw new Error('desktop carrier only accepts string request bodies')
  }
  return init.body
}

/**
 * Build a fetch-shaped unary leg over the preload bridge.
 * @param bridge - sandboxed, context-isolated preload bridge selected by the desktop carrier.
 * @returns fetch-compatible unary transport forwarding requests through the bridge.
 */
export function createDesktopFetch(bridge: DesktopBridge): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inputRequest = input instanceof Request ? input : undefined
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input
    const method = init?.method ?? inputRequest?.method ?? 'GET'
    const headers = new Headers(init?.headers ?? inputRequest?.headers)
    const body = requestBody(init)
    const signal = init?.signal ?? inputRequest?.signal
    const id = crypto.randomUUID()
    if (signal?.aborted === true) throw signal.reason

    let rejectAbort: ((reason?: unknown) => void) | undefined
    const aborted = signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const handleAbort = (): void => {
      bridge.cancelRequest(id)
      rejectAbort?.(signal?.reason)
    }
    signal?.addEventListener('abort', handleAbort, { once: true })
    try {
      const pending = bridge.request({
        id,
        url,
        method,
        headers: [...headers.entries()],
        ...(body === undefined ? {} : { body }),
      })
      const response = await (aborted === undefined ? pending : Promise.race([pending, aborted]))
      return new Response(response.body, {
        status: response.status,
        headers: response.headers.map(([name, value]) => [name, value]),
      })
    } finally {
      signal?.removeEventListener('abort', handleAbort)
    }
  }
}

/** Existing abstract client with only its physical transport aspects replaced. */
export class DesktopApiClient extends AbstractApiClient {
  private readonly fetcher: typeof fetch

  constructor(private readonly bridge: DesktopBridge) {
    super()
    this.fetcher = createDesktopFetch(bridge)
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.fetcher(input, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readStream('mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readStream('host', signal, hostFrameSchema, onOpen)
  }

  private async *readStream<F extends MuxFrame | HostFrame>(
    stream: DesktopStream,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const id = crypto.randomUUID()
    // Lifecycle items never enter the inbox: enqueue routes end/error to
    // `terminal`, so the inbox holds only un-consumed frames.
    const inbox: RpcRequest<F>[] = []
    let terminal: StreamItem<F> | undefined
    let wake: (() => void) | undefined
    const wakeReader = (): void => {
      const reader = wake
      wake = undefined
      reader?.()
    }
    const enqueue = (item: StreamItem<F>): void => {
      if (terminal !== undefined) return
      if (item.kind !== 'frame') {
        terminal = item
        wakeReader()
        return
      }
      if (inbox.length >= DESKTOP_STREAM_QUEUE_LIMIT) {
        inbox.length = 0
        terminal = {
          kind: 'error',
          error: new Error(`desktop ${stream} stream queue limit of ${String(DESKTOP_STREAM_QUEUE_LIMIT)} frames exceeded`),
        }
        this.bridge.cancelSubscription(id)
        wakeReader()
        return
      }
      inbox.push(item.envelope)
      wakeReader()
    }
    const unsubscribe = this.bridge.onStream((event) => {
      if (event.id !== id) return
      if (event.type === 'open') {
        onOpen?.()
        this.bridge.ackStream(id)
        return
      }
      if (event.type === 'end') {
        enqueue({ kind: 'end' })
        return
      }
      if (event.type === 'error') {
        enqueue({ kind: 'error', error: new Error(event.message) })
        return
      }
      let full: ServerRequest
      let frame: F
      try {
        full = serverRequestSchema.parse(event.message)
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed desktop frame on ${stream}:`, error)
        return
      }
      if (terminal !== undefined || inbox.length >= DESKTOP_STREAM_QUEUE_LIMIT) {
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
        return
      }
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
      this.onEnvelope(full)
    })
    const handleAbort = (): void => {
      this.bridge.cancelSubscription(id)
      inbox.length = 0
      enqueue({ kind: 'end' })
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    this.bridge.subscribe(id, stream)
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as RpcRequest<F>
          yield item
          // The consumer finished this frame and asked for the next one: only
          // now is the frame consumed, so only now may the child send more.
          this.bridge.ackStream(id)
        }
        if (terminal?.kind === 'end') {
          this.bridge.ackStream(id)
          return
        }
        if (terminal?.kind === 'error') {
          this.bridge.ackStream(id)
          throw terminal.error
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      unsubscribe()
      this.bridge.cancelSubscription(id)
    }
  }
}
