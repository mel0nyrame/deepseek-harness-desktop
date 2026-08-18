/** macOS desktop Host contribution for the durable sidebar-glass preference. */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  SIDEBAR_GLASS_SETTINGS_NAMESPACE,
  SidebarGlassSettingsSchema,
} from './sidebar-glass-settings.ts'

/** Cordis plugin identity for diagnostics and inventory. */
export const name = 'ui-sidebar-glass-macos'
/** The desktop contribution cannot function without the durable settings owner. */
export const inject = ['settings']

/** Register the preference only while the macOS desktop entry is active. */
export function apply(ctx: Context): void {
  ctx.settings.register(
    settingsNamespace(SIDEBAR_GLASS_SETTINGS_NAMESPACE),
    SidebarGlassSettingsSchema,
  )
}
