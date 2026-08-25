/** Electron preload carrier for the published Client Connection contract. */

import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import {
  AbstractApiClient,
  RpcId,
  type IApiClient,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {
  ApiProxy,
  HostFrame,
  MuxFrame,
  RpcMessage,
  RpcRequest,
  ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  ConnectionHandle,
  ConnectionTransport,
} from '@deepseek-ai/dsh-client-connection/client'

export { RpcId }
export type { ConnectionHandle, ConnectionTransport, IApiClient, RpcMessage }

/** Request copied across the context-isolated preload interface. */
export interface DesktopBridgeRequest {
  readonly id: string
  readonly url: string
  readonly method: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body?: string
}

/** Complete unary response copied back through the preload interface. */
export interface DesktopBridgeResponse {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly body: string
}

/** Logical downstream names carried by the desktop connection. */
export type DesktopStream = 'mux' | 'host'

/** One validated stream notification delivered by preload. */
export type DesktopStreamEvent =
  | { readonly type: 'open'; readonly id: string }
  | { readonly type: 'message'; readonly id: string; readonly message: unknown }
  | { readonly type: 'error'; readonly id: string; readonly message: string }
  | { readonly type: 'end'; readonly id: string }

/** Narrow renderer interface exposed by the context-isolated preload script. */
export interface DesktopBridge {
  request(request: DesktopBridgeRequest): Promise<DesktopBridgeResponse>
  cancelRequest(id: string): void
  subscribe(id: string, stream: DesktopStream): void
  cancelSubscription(id: string): void
  ackStream(id: string): void
  onStream(listener: (event: DesktopStreamEvent) => void): () => void
}

/** Maximum parsed frames retained for one renderer subscription. */
export const DESKTOP_STREAM_QUEUE_LIMIT = 256

type StreamItem<F> =
  | { readonly kind: 'frame'; readonly envelope: RpcRequest<F> }
  | { readonly kind: 'end' }
  | { readonly kind: 'error'; readonly error: Error }

interface Parser<F> {
  parse(value: unknown): F
}

function requestBody(init: RequestInit | undefined): string | undefined {
  if (init?.body === undefined || init.body === null) return undefined
  if (typeof init.body !== 'string') {
    throw new Error('desktop connection accepts only string request bodies')
  }
  return init.body
}

function desktopUrl(value: string): string {
  const url = new URL(value)
  if (url.origin !== 'http://dsh.internal') return value
  return `dsh://app${url.pathname}${url.search}${url.hash}`
}

/** Build a fetch-shaped unary leg over the preload bridge. */
export function createDesktopFetch(bridge: DesktopBridge): typeof fetch {
  const fetcher: typeof fetch = async (input, init): Promise<Response> => {
    const inputRequest = input instanceof Request ? input : undefined
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input
    const signal = init?.signal ?? inputRequest?.signal
    const id = crypto.randomUUID()
    if (signal?.aborted === true) throw signal.reason

    let rejectAbort: ((reason?: unknown) => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const onAbort = (): void => {
      bridge.cancelRequest(id)
      rejectAbort?.(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const body = requestBody(init)
      const pending = bridge.request({
        id,
        url: desktopUrl(url),
        method: init?.method ?? inputRequest?.method ?? 'GET',
        headers: [...new Headers(init?.headers ?? inputRequest?.headers).entries()],
        ...(body === undefined ? {} : { body }),
      })
      const response = signal === undefined ? await pending : await Promise.race([pending, aborted])
      return new Response(response.body, {
        status: response.status,
        headers: response.headers.map(([name, value]): [string, string] => [name, value]),
      })
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
  return fetcher
}

/** Official API client with only its physical unary and stream aspects replaced. */
export class DesktopApiClient extends AbstractApiClient {
  private readonly fetcher: typeof fetch
  private readonly bridge: DesktopBridge

  constructor(bridge: DesktopBridge) {
    super()
    this.bridge = bridge
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
      try {
        const full: ServerRequest = serverRequestSchema.parse(event.message)
        const frame = frameSchema.parse(full.payload)
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
        this.onEnvelope(full)
      } catch (error) {
        console.error(`[desktop-connection] dropping malformed ${stream} frame:`, error)
        this.bridge.ackStream(id)
      }
    })
    const onAbort = (): void => {
      this.bridge.cancelSubscription(id)
      inbox.length = 0
      enqueue({ kind: 'end' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.bridge.subscribe(id, stream)
    if (signal.aborted) onAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          yield inbox.shift() as RpcRequest<F>
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
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
      this.bridge.cancelSubscription(id)
    }
  }
}
