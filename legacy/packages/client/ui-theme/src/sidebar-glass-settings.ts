/** Durable macOS sidebar-glass settings shared by Host and Client. */

import z from '@deepseek-ai/schemastery'

/** Host settings namespace owned by the macOS desktop Appearance contribution. */
export const SIDEBAR_GLASS_SETTINGS_NAMESPACE = 'ui-sidebar-glass-macos'

/** Field carrying the user's saved sidebar glass preference. */
export const SIDEBAR_GLASS_EFFECT_FIELD = 'enabled'

/** Default saved preference. */
export const DEFAULT_SIDEBAR_GLASS_EFFECT = true

/** Durable sidebar glass section. */
export interface SidebarGlassSettings {
  /** Whether the sidebar should use glass when accessibility permits it. */
  enabled: boolean
}

/** Host and wire schema for the sidebar glass section. */
export const SidebarGlassSettingsSchema: z<SidebarGlassSettings> = z.object({
  [SIDEBAR_GLASS_EFFECT_FIELD]: z.boolean().default(DEFAULT_SIDEBAR_GLASS_EFFECT),
})
