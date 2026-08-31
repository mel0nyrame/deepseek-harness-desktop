/** Validated messages crossing the desktop connection IPC boundary. */

import { isAbsolute } from 'node:path'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type {
  DesktopBridgeRequest,
  DesktopBridgeResponse,
  DesktopStream,
  DesktopStreamEvent,
} from './carrier.js'

/** Native desktop action the Host child requests from the Electron shell. */
export type DesktopCapabilityAction = 'pick-directory' | 'open-path'

/** Maximum byte length accepted for one wire-transferred filesystem path. */
const DESKTOP_CAPABILITY_PATH_LIMIT = 4_096

/**
 * Result the shell settles one native action with: a picked directory path
 * (`null` when the operator cancelled) or confirmation that an open handed
 * the path to the operating system.
 */
export type DesktopCapabilityValue =
  | { readonly kind: 'path'; readonly path: string | null }
  | { readonly kind: 'opened' }

/** Renderer command sent through Electron main to the Host connection provider. */
export type DesktopParentMessage =
  | ({ readonly type: 'request' } & DesktopBridgeRequest)
  | { readonly type: 'cancel-request'; readonly id: string }
  | { readonly type: 'subscribe'; readonly id: string; readonly stream: DesktopStream }
  | { readonly type: 'cancel-subscription'; readonly id: string }
  | { readonly type: 'stream-ack'; readonly id: string }
  | ({ readonly type: 'capability-response'; readonly id: string } & DesktopCapabilityValue)
  | { readonly type: 'capability-error'; readonly id: string; readonly message: string }

/** Host connection notification sent through Electron main to the renderer. */
export type DesktopChildMessage =
  | { readonly type: 'connection-ready' }
  | ({ readonly type: 'response'; readonly id: string } & DesktopBridgeResponse)
  | { readonly type: 'request-error'; readonly id: string; readonly message: string }
  | { readonly type: 'stream-open'; readonly id: string }
  | { readonly type: 'stream-message'; readonly id: string; readonly message: unknown }
  | { readonly type: 'stream-error'; readonly id: string; readonly message: string }
  | { readonly type: 'stream-end'; readonly id: string }
  | { readonly type: 'capability-request'; readonly action: 'pick-directory'; readonly id: string }
  | { readonly type: 'capability-request'; readonly action: 'open-path'; readonly id: string; readonly path: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')
}

function isMessage(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096
}

function isCapabilityPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && new TextEncoder().encode(value).length <= DESKTOP_CAPABILITY_PATH_LIMIT
    && !value.includes('\0') && isAbsolute(value)
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

/** Parse one shell-capability request arriving at Electron main from the Host child. */
export function parseDesktopCapabilityRequest(value: unknown):
  | Extract<DesktopChildMessage, { type: 'capability-request' }>
  | undefined {
  if (!isRecord(value) || value.type !== 'capability-request' || !isId(value.id)) return undefined
  if (value.action === 'pick-directory') {
    return { type: 'capability-request', action: 'pick-directory', id: value.id }
  }
  if (value.action === 'open-path' && isCapabilityPath(value.path)) {
    return { type: 'capability-request', action: 'open-path', id: value.id, path: value.path }
  }
  return undefined
}

/** Parse one shell-capability settlement arriving at the Host child from Electron main. */
export function parseDesktopCapabilityResponse(value: unknown):
  | Extract<DesktopParentMessage, { type: 'capability-response' | 'capability-error' }>
  | undefined {
  if (!isRecord(value) || !isId(value.id)) return undefined
  if (value.type === 'capability-response') {
    if (value.kind === 'opened') return { type: 'capability-response', id: value.id, kind: 'opened' }
    if (value.kind !== 'path') return undefined
    const path = value.path
    return path === null || isCapabilityPath(path)
      ? { type: 'capability-response', id: value.id, kind: 'path', path }
      : undefined
  }
  if (value.type === 'capability-error') {
    return isMessage(value.message)
      ? { type: 'capability-error', id: value.id, message: value.message }
      : undefined
  }
  return undefined
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
  return parseDesktopCapabilityResponse(value)
}

/** Parse one notification arriving from the Host child process. */
export function parseDesktopChildMessage(value: unknown): DesktopChildMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  if (value.type === 'connection-ready') return { type: 'connection-ready' }
  if (!isId(value.id)) return undefined
  if (value.type === 'response') {
    const response = parseDesktopBridgeResponse(value)
    return response === undefined ? undefined : { type: 'response', id: value.id, ...response }
  }
  if (value.type === 'request-error' || value.type === 'stream-error') {
    return typeof value.message === 'string'
      ? { type: value.type, id: value.id, message: value.message }
      : undefined
  }
  if (value.type === 'stream-open' || value.type === 'stream-end') {
    return { type: value.type, id: value.id }
  }
  if (value.type === 'stream-message') {
    return { type: 'stream-message', id: value.id, message: value.message }
  }
  return parseDesktopCapabilityRequest(value)
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
