/** Host contribution for the durable macOS sidebar material preference. */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
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

/** Register the desktop material preference when a settings provider is available. */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsContext) => {
    settingsContext.settings.register(
      settingsNamespace(SIDEBAR_GLASS_SETTINGS_NAMESPACE),
      SidebarGlassSettingsSchema,
    )
  })
}
