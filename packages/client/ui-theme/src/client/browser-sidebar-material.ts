/** Browser adapter for the desktop sidebar material facts and DOM projection. */

import type { SidebarMaterialEnvironment } from './sidebar-glass-runtime.ts'
import type { SidebarMaterial, SidebarMaterialFacts } from './sidebar-material.ts'

/** Bridge native renderer facts and the active application theme into the material runtime. */
export class BrowserSidebarMaterialEnvironment implements SidebarMaterialEnvironment {
  private readonly listeners = new Set<() => void>()
  private observer: MutationObserver | undefined

  constructor(private readonly getColorScheme: () => 'light' | 'dark') {}

  getFacts(): Omit<SidebarMaterialFacts, 'enabled'> {
    const body = typeof document === 'undefined' ? undefined : document.body
    return {
      platform: body?.dataset.dshPlatform ?? '',
      reducedTransparency: body?.dataset.dshTransparency === 'reduced',
      colorScheme: this.getColorScheme(),
    }
  }

  apply(material: SidebarMaterial): void {
    const body = typeof document === 'undefined' ? undefined : document.body
    if (body === undefined) return
    if (body.dataset.dshPlatform === 'darwin') {
      body.dataset.dshSidebarMaterial = material
    } else {
      delete body.dataset.dshSidebarMaterial
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.startObserving()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.observer?.disconnect()
        this.observer = undefined
      }
    }
  }

  /** Publish a theme-driven fact change through the same environment channel. */
  refresh(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[ui-theme] sidebar material listener failed:', error)
      }
    }
  }

  private startObserving(): void {
    if (this.observer !== undefined || typeof MutationObserver === 'undefined'
      || typeof document === 'undefined') return
    this.observer = new MutationObserver(() => { this.refresh() })
    this.observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-dsh-platform', 'data-dsh-transparency'],
    })
  }
}
