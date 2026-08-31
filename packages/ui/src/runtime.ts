/** Runtime joining durable glass preference state to the native window bridge. */

import {
  applyDesktopSurfaceState,
  resolveSidebarMaterial,
  type DesktopNativeSurfaceState,
  type DesktopSurfaceBodyLike,
  type SidebarMaterial,
} from './surface.js'

export interface SidebarGlassSettingsScopeLike {
  getSnapshot(): {
    readonly status: string
    readonly value: { readonly enabled: boolean } | undefined
    readonly writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: 'enabled', value: boolean): Promise<void>
}

export interface NativeThemeBridgeLike {
  getState(): DesktopNativeSurfaceState
  setPreference(preference: 'light' | 'dark' | 'system'): void
  onState(listener: (state: DesktopNativeSurfaceState) => void): () => void
}

export interface DesktopSurfaceSnapshot {
  readonly available: boolean
  readonly enabled: boolean
  readonly systemOverride: boolean
  readonly material: SidebarMaterial
  readonly state: DesktopNativeSurfaceState
  readonly revision: number
}

/** Own the live native-state projection and durable sidebar-glass preference. */
export class DesktopSurfaceRuntime {
  private readonly listeners = new Set<() => void>()
  private readonly disposeSettings: () => void
  private readonly disposeNativeState: () => void
  private enabled = true
  private state: DesktopNativeSurfaceState
  private disposed = false
  private revision = -1
  private snapshot: DesktopSurfaceSnapshot
  private readonly settings: SidebarGlassSettingsScopeLike
  private readonly body: DesktopSurfaceBodyLike

  constructor(
    settings: SidebarGlassSettingsScopeLike,
    nativeTheme: NativeThemeBridgeLike,
    body: DesktopSurfaceBodyLike,
  ) {
    this.settings = settings
    this.body = body
    this.state = nativeTheme.getState()
    this.snapshot = Object.freeze({
      available: false,
      enabled: true,
      systemOverride: false,
      material: 'opaque' as const,
      state: this.state,
      revision: this.revision,
    })
    this.disposeSettings = settings.subscribe(() => { this.adoptSettings() })
    this.disposeNativeState = nativeTheme.onState((state) => {
      if (this.disposed) return
      this.state = state
      this.publish()
    })
    this.adoptSettings()
  }

  /** Return the stable current surface snapshot. */
  getSnapshot(): DesktopSurfaceSnapshot {
    return this.snapshot
  }

  /**
   * Observe snapshot replacements.
   *
   * @returns a disposer for this subscription.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Apply a user preference immediately and persist it through the settings scope. */
  setEnabled(enabled: boolean): void {
    if (this.disposed || !this.snapshot.available || enabled === this.enabled) return
    this.enabled = enabled
    this.publish()
    void this.settings.set('enabled', enabled)
  }

  /** Stop native/settings observation and release all renderer listeners. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeSettings()
    this.disposeNativeState()
    this.listeners.clear()
  }

  private adoptSettings(): void {
    if (this.disposed) return
    const value = this.settings.getSnapshot().value
    if (value !== undefined) this.enabled = value.enabled
    this.publish()
  }

  private publish(): void {
    if (this.disposed) return
    const host = this.settings.getSnapshot()
    const available = this.state.platform === 'darwin' && host.status === 'ready' && host.writable
    const material = resolveSidebarMaterial(this.state, available && this.enabled)
    applyDesktopSurfaceState(this.body, this.state, available && this.enabled)
    this.revision += 1
    this.snapshot = Object.freeze({
      available,
      enabled: this.enabled,
      systemOverride: available && this.state.transparency === 'opaque',
      material,
      state: this.state,
      revision: this.revision,
    })
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[desktop-ui] surface listener threw:', error)
      }
    }
  }
}
