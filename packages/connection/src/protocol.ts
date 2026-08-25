/** Validated messages crossing the desktop connection IPC boundary. */

import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type {
  DesktopBridgeRequest,
  DesktopBridgeResponse,
  DesktopStream,
  DesktopStreamEvent,
} from './carrier.js'

/** Renderer command sent through Electron main to the Host connection provider. */
export type DesktopParentMessage =
  | ({ readonly type: 'request' } & DesktopBridgeRequest)
  | { readonly type: 'cancel-request'; readonly id: string }
  | { readonly type: 'subscribe'; readonly id: string; readonly stream: DesktopStream }
  | { readonly type: 'cancel-subscription'; readonly id: string }
  | { readonly type: 'stream-ack'; readonly id: string }

/** Host connection notification sent through Electron main to the renderer. */
export type DesktopChildMessage =
  | ({ readonly type: 'response'; readonly id: string } & DesktopBridgeResponse)
  | { readonly type: 'request-error'; readonly id: string; readonly message: string }
  | { readonly type: 'stream-open'; readonly id: string }
  | { readonly type: 'stream-message'; readonly id: string; readonly message: unknown }
  | { readonly type: 'stream-error'; readonly id: string; readonly message: string }
  | { readonly type: 'stream-end'; readonly id: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')
}

function isDesktopAppUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8_192) return false
  try {
    const url = new URL(value)
    return url.protocol === 'dsh:' && url.hostname === 'app' && url.port === ''
      && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function parseHeaders(value: unknown): Array<readonly [string, string]> | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined
  const headers: Array<readonly [string, string]> = []
  for (const header of value) {
    if (!Array.isArray(header) || header.length !== 2
      || typeof header[0] !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header[0])
      || typeof header[1] !== 'string' || header[1].includes('\r')
      || header[1].includes('\n') || header[1].includes('\0')) return undefined
    headers.push([header[0], header[1]])
  }
  return headers
}

/** Parse one renderer request before invoking Electron main. */
export function parseDesktopBridgeRequest(value: unknown): DesktopBridgeRequest | undefined {
  if (!isRecord(value) || !isId(value.id) || !isDesktopAppUrl(value.url)
    || value.method !== 'GET' && value.method !== 'HEAD' && value.method !== 'POST') return undefined
  const headers = parseHeaders(value.headers)
  if (headers === undefined || value.body !== undefined && typeof value.body !== 'string') return undefined
  return {
    id: value.id,
    url: value.url,
    method: value.method,
    headers,
    ...(value.body === undefined ? {} : { body: value.body }),
  }
}

/** Parse one Electron-main unary response before returning it to the Client. */
export function parseDesktopBridgeResponse(value: unknown): DesktopBridgeResponse | undefined {
  if (!isRecord(value) || typeof value.status !== 'number' || !Number.isInteger(value.status)
    || value.status < 100 || value.status > 599 || typeof value.body !== 'string') return undefined
  const headers = parseHeaders(value.headers)
  return headers === undefined ? undefined : { status: value.status, headers, body: value.body }
}

/** Parse one command arriving at the Host process boundary. */
export function parseDesktopParentMessage(value: unknown): DesktopParentMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || !isId(value.id)) return undefined
  if (value.type === 'request') {
    const request = parseDesktopBridgeRequest(value)
    return request === undefined ? undefined : { type: 'request', ...request }
  }
  if (value.type === 'subscribe') {
    return value.stream === 'mux' || value.stream === 'host'
      ? { type: 'subscribe', id: value.id, stream: value.stream }
      : undefined
  }
  if (value.type === 'cancel-request' || value.type === 'cancel-subscription' || value.type === 'stream-ack') {
    return { type: value.type, id: value.id }
  }
  return undefined
}

/** Parse one stream notification using the subscription's logical stream schema. */
export function parseDesktopStreamEvent(
  value: unknown,
  subscriptions: ReadonlyMap<string, DesktopStream>,
): DesktopStreamEvent | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || !isId(value.id)) return undefined
  const stream = subscriptions.get(value.id)
  if (stream === undefined) return undefined
  if (value.type === 'open') return { type: 'open', id: value.id }
  if (value.type === 'end') return { type: 'end', id: value.id }
  if (value.type === 'error') {
    return typeof value.message === 'string' ? { type: 'error', id: value.id, message: value.message } : undefined
  }
  if (value.type !== 'message') return undefined
  const envelope = serverRequestSchema.safeParse(value.message)
  if (!envelope.success) return undefined
  const frame = (stream === 'mux' ? muxFrameSchema : hostFrameSchema).safeParse(envelope.data.payload)
  return frame.success ? { type: 'message', id: value.id, message: envelope.data } : undefined
}
