/** Electron protocol adapter for Host-owned official frontend assets. */

import type { DesktopParentMessage } from '@dsh-desktop/connection'
import type { DesktopBridgeResponse } from '@dsh-desktop/connection/carrier'

/** Product origin used by the official frontend inside Electron. */
export const DESKTOP_UI_URL = 'dsh://app/index.html'

// The largest exact rc.8 asset encodes below 1.5 MiB; the remaining headroom
// bounds main-process allocation without excluding any assembled artifact.
const MAX_ASSET_BODY_BASE64_LENGTH = 2 * 1024 * 1024

/** Supervisor surface required by the UI protocol adapter. */
export interface DesktopUiProtocolRuntime {
  /** Send one Host request and settle with its complete bridge response. */
  request(message: Extract<DesktopParentMessage, { type: 'request' }>): Promise<DesktopBridgeResponse>
  /** Cancel the matching Host request after the Electron fetch is aborted. */
  cancelRequest(id: string): void
}

interface AssetValue {
  readonly status: 200 | 404
  readonly contentType: string
  readonly cacheControl: 'no-cache'
  readonly body: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function decodeAssetResponse(response: DesktopBridgeResponse, rpcId: string): AssetValue | undefined {
  if (response.status !== 200) return undefined
  let envelope: unknown
  try {
    envelope = JSON.parse(response.body)
  } catch {
    return undefined
  }
  if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || !isRecord(envelope.result) || envelope.result.ok !== true || !isRecord(envelope.result.value)) return undefined
  const value = envelope.result.value
  if (value.status !== 200 && value.status !== 404
    || typeof value.contentType !== 'string' || value.contentType.length > 256
    || value.contentType.includes('\r') || value.contentType.includes('\n')
    || value.contentType.includes('\0') || value.cacheControl !== 'no-cache'
    || typeof value.body !== 'string' || value.body.length > MAX_ASSET_BODY_BASE64_LENGTH
    || value.body.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.body)) return undefined
  return {
    status: value.status,
    contentType: value.contentType,
    cacheControl: value.cacheControl,
    body: value.body,
  }
}

function acceptsProductRequest(request: Request): boolean {
  try {
    const url = new URL(request.url)
    return url.protocol === 'dsh:' && url.hostname === 'app' && url.port === ''
      && url.username === '' && url.password === '' && url.hash === ''
  } catch {
    return false
  }
}

/**
 * Create the handler installed on Electron's secure `dsh` scheme.
 * The handler admits GET and HEAD only on `dsh://app`, maps invalid origins to
 * 403, methods to 405, aborts to 499, and malformed or failed Host replies to
 * 502. Valid asset misses preserve Host 404 responses; HEAD omits the body.
 */
export function createDesktopUiProtocolHandler(
  runtime: DesktopUiProtocolRuntime,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!acceptsProductRequest(request)) return new Response('forbidden', { status: 403 })
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 })
    }
    const id = crypto.randomUUID()
    const rpcId = crypto.randomUUID()
    const onAbort = (): void => { runtime.cancelRequest(id) }
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (request.signal.aborted) return new Response('request cancelled', { status: 499 })
      const source = new URL(request.url)
      const response = await runtime.request({
        type: 'request',
        id,
        url: 'dsh://app/ui/asset',
        method: 'POST',
        headers: [['content-type', 'application/json']],
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'asset',
          payload: { path: source.pathname },
        }),
      })
      const asset = decodeAssetResponse(response, rpcId)
      if (asset === undefined) return new Response('invalid desktop UI asset response', { status: 502 })
      const body = request.method === 'HEAD' ? null : new Uint8Array(Buffer.from(asset.body, 'base64'))
      return new Response(body, {
        status: asset.status,
        headers: {
          'cache-control': asset.cacheControl,
          'content-type': asset.contentType,
        },
      })
    } catch (error) {
      if (request.signal.aborted) return new Response('request cancelled', { status: 499 })
      console.error('[desktop-ui] asset request failed:', error)
      return new Response('desktop UI asset request failed', { status: 502 })
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}
