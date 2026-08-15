/** Validation and translation at the untrusted renderer IPC boundary. */

import type { DesktopChildMessage, DesktopChildRequest } from '@deepseek-ai/dsh-desktop-app'

type StreamMessage = Exclude<DesktopChildMessage,
  Extract<DesktopChildMessage, { type: 'ready' | 'response' | 'request-error' }>>

/** Stream lifecycle shape consumed by the context-isolated preload bridge. */
export type RendererStreamEvent =
  | { readonly type: 'open'; readonly id: string }
  | { readonly type: 'message'; readonly id: string; readonly message: unknown }
  | { readonly type: 'error'; readonly id: string; readonly message: string }
  | { readonly type: 'end'; readonly id: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Whether a frame or navigation URL belongs to the exact privileged app host. */
export function isDesktopAppUrl(value: string): boolean {
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

/** Validate one renderer unary request and tag it for the child protocol. */
export function parseRendererRequest(value: unknown): DesktopChildRequest | undefined {
  if (!isRecord(value)
    || !isId(value.id)
    || typeof value.url !== 'string'
    || !isDesktopAppUrl(value.url)
    || typeof value.method !== 'string'
    || value.method.length === 0
    || !Array.isArray(value.headers)) return undefined
  const headers: Array<[string, string]> = []
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

/** Validate one renderer-owned request or subscription id. */
export function parseRendererId(value: unknown): string | undefined {
  return isId(value) ? value : undefined
}

/** Validate one renderer subscription command. */
export function parseRendererSubscription(
  id: unknown,
  stream: unknown,
): { id: string; stream: 'mux' | 'host' } | undefined {
  if (!isId(id) || (stream !== 'mux' && stream !== 'host')) return undefined
  return { id, stream }
}

/** Validate one status-page recovery action. */
export function parseRendererRecoveryAction(value: unknown): 'restart' | 'quit' | undefined {
  return value === 'restart' || value === 'quit' ? value : undefined
}

/** Validate one main-to-preload stream lifecycle message before renderer delivery. */
export function parseRendererStreamEvent(value: unknown): RendererStreamEvent | undefined {
  if (!isRecord(value) || !isId(value.id) || typeof value.type !== 'string') return undefined
  switch (value.type) {
    case 'open':
    case 'end':
      return { type: value.type, id: value.id }
    case 'message':
      return Object.hasOwn(value, 'message')
        ? { type: 'message', id: value.id, message: value.message }
        : undefined
    case 'error':
      return typeof value.message === 'string'
        ? { type: 'error', id: value.id, message: value.message }
        : undefined
    default:
      return undefined
  }
}

/** Translate child protocol names to the preload carrier's public vocabulary. */
export function toRendererStreamEvent(message: StreamMessage): RendererStreamEvent {
  switch (message.type) {
    case 'stream-open': return { type: 'open', id: message.id }
    case 'stream-message': return { type: 'message', id: message.id, message: message.message }
    case 'stream-error': return { type: 'error', id: message.id, message: message.message }
    case 'stream-end': return { type: 'end', id: message.id }
    default: return message satisfies never
  }
}
