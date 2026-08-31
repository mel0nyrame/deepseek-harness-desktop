/** Host contribution for the durable macOS sidebar material preference. */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DesktopUiAssets } from './assets.js'
import {
  DEFAULT_SIDEBAR_GLASS_EFFECT,
  SIDEBAR_GLASS_SETTINGS_NAMESPACE,
  type SidebarGlassSettings,
} from './contract.js'

export const name = '@dsh-desktop/ui'

export {
  DEFAULT_SIDEBAR_GLASS_EFFECT,
  SIDEBAR_GLASS_SETTINGS_NAMESPACE,
  type SidebarGlassSettings,
} from './contract.js'

export const SidebarGlassSettingsSchema: z<SidebarGlassSettings> = z.object({
  enabled: z.boolean().default(DEFAULT_SIDEBAR_GLASS_EFFECT),
})

function badAssetRequest(message: string) {
  return {
    ok: false as const,
    error: {
      code: 'bad-request' as const,
      message,
      details: { issues: [] },
    },
  }
}

/**
 * Create the transport-neutral asset RPC handler used by Electron's protocol.
 * Unknown endpoints and non-string paths return `bad-request`; every valid
 * asset request is successful at the RPC layer, including an asset-level 404.
 */
export function createDesktopUiAssetHandler(assets: DesktopUiAssets): ConnectionRpcHandler {
  return async (endpoint, payload) => {
    if (endpoint !== 'asset') return badAssetRequest(`unknown desktop UI endpoint ${JSON.stringify(endpoint)}`)
    if (typeof payload !== 'object' || payload === null
      || typeof (payload as { path?: unknown }).path !== 'string') {
      return badAssetRequest('desktop UI asset payload requires a path string')
    }
    return { ok: true, value: await assets.read((payload as { path: string }).path) }
  }
}

/**
 * Register settings and asset contributions when their providers are present.
 * Settings registration belongs to the injected Cordis fiber and disappears
 * when this Host contribution unloads; the `/ui` route is an explicit effect.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsContext) => {
    settingsContext.settings.register(
      settingsNamespace(SIDEBAR_GLASS_SETTINGS_NAMESPACE),
      SidebarGlassSettingsSchema,
    )
  })
  ctx.inject(['clientModules', 'connection'], (uiContext) => {
    const assets = new DesktopUiAssets(uiContext.clientModules)
    uiContext.effect(
      () => uiContext.connection.rpc.handle(
        '/ui',
        createDesktopUiAssetHandler(assets),
        { authority: 'loopback' },
      ),
      'desktop-ui: official frontend assets',
    )
  })
}
