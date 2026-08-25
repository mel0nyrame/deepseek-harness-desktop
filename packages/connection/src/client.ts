/** Browser plugin selecting the desktop physical carrier. */

import type { Context } from '@deepseek-ai/cordis'
import {
  createConnectionHandle,
  createFetchConnectionRpc,
} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle, ConnectionTransport } from './carrier.js'
import { createDesktopFetch, DesktopApiClient, type DesktopBridge } from './carrier.js'

declare global {
  var dshDesktop: DesktopBridge | undefined
}

/** Stable Client plugin name. */
export const name = 'desktop-connection'

/** Required Client services (none; this is the wire root). */
export const inject: string[] = []

/** Test seam for the browser ModuleLoader-provided official connection factories. */
export const internals: {
  createConnectionHandle(transport: ConnectionTransport): ConnectionHandle
  createFetchConnectionRpc(fetcher: typeof fetch): ConnectionTransport['rpc']
} = { createConnectionHandle, createFetchConnectionRpc }

/** Provide the published Client Connection contract over the preload bridge. */
export function apply(ctx: Context): void {
  const bridge = globalThis.dshDesktop
  if (bridge === undefined) throw new Error('desktop connection: preload bridge is unavailable')
  const fetcher = createDesktopFetch(bridge)
  ctx.provide('connection', internals.createConnectionHandle({
    api: new DesktopApiClient(bridge),
    rpc: internals.createFetchConnectionRpc(fetcher),
    isLoopback: true,
  }))
}
