/** Effective sidebar material selected from durable and platform facts. */

/** Renderer-applied sidebar material and palette pair. */
export type SidebarMaterial = 'glass-light' | 'glass-dark' | 'opaque-light' | 'opaque-dark'

/** Inputs that determine the sidebar's rendered material. */
export interface SidebarMaterialFacts {
  /** Saved user preference. */
  enabled: boolean
  /** Current macOS accessibility override. */
  reducedTransparency: boolean
  /** Resolved application theme. */
  colorScheme: 'light' | 'dark'
  /** Desktop renderer platform fact. */
  platform: string
}

/**
 * Resolve the effective material without changing the saved preference.
 * @param facts - durable preference plus current renderer facts.
 * @returns one explicit material/palette combination.
 */
export function resolveSidebarMaterial(facts: SidebarMaterialFacts): SidebarMaterial {
  const translucent = facts.platform === 'darwin'
    && facts.enabled
    && !facts.reducedTransparency
  return `${translucent ? 'glass' : 'opaque'}-${facts.colorScheme}`
}
