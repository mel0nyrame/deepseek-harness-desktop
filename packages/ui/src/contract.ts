/** Host/Client-neutral contracts shared by desktop UI contributions. */

export const SIDEBAR_GLASS_SETTINGS_NAMESPACE = 'ui-sidebar-glass-macos'
export const DEFAULT_SIDEBAR_GLASS_EFFECT = true

export interface SidebarGlassSettings {
  readonly enabled: boolean
}
