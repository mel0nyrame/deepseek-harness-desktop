/** Runtime owner for the durable sidebar preference and effective material. */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_SIDEBAR_GLASS_EFFECT,
  SIDEBAR_GLASS_EFFECT_FIELD,
  type SidebarGlassSettings,
} from '../sidebar-glass-settings.ts'
import { resolveSidebarMaterial, type SidebarMaterial, type SidebarMaterialFacts } from './sidebar-material.ts'

/** Snapshot rendered by the settings row and desktop surface. */
export interface SidebarGlassSnapshot extends SidebarMaterialFacts {
  /** Whether the macOS Host contribution is ready and writable. */
  available: boolean
  /** Whether Reduce Transparency currently overrides the saved preference. */
  systemOverride: boolean
  /** Effective material applied to the renderer. */
  material: SidebarMaterial
  /** Monotonic publication revision. */
  revision: number
}

/** Renderer facts and material sink owned outside settings persistence. */
export interface SidebarMaterialEnvironment {
  getFacts(): Omit<SidebarMaterialFacts, 'enabled'>
  apply(material: SidebarMaterial): void
  subscribe(listener: () => void): () => void
}

/** Own the saved preference and its effective renderer projection. */
export class SidebarGlassRuntime {
  private readonly listeners = new Set<(snapshot: SidebarGlassSnapshot) => void>()
  private snapshot: SidebarGlassSnapshot = {
    enabled: DEFAULT_SIDEBAR_GLASS_EFFECT,
    reducedTransparency: false,
    colorScheme: 'light',
    platform: '',
    available: false,
    systemOverride: false,
    material: 'opaque-light',
    revision: 0,
  }
  private enabled = DEFAULT_SIDEBAR_GLASS_EFFECT
  private revision = -1
  private readonly disposeHost: () => void
  private readonly disposeEnvironment: () => void
  private disposed = false

  constructor(
    private readonly host: SettingsScope<SidebarGlassSettings>,
    private readonly environment: SidebarMaterialEnvironment,
  ) {
    this.disposeHost = host.subscribe(() => { this.adopt() })
    this.disposeEnvironment = environment.subscribe(() => { this.publish() })
    this.adopt()
  }

  /**
   * Read the latest immutable preference and material projection.
   * @returns current published snapshot.
   */
  getSnapshot(): SidebarGlassSnapshot {
    return this.snapshot
  }

  /**
   * Subscribe to preference, theme, or platform-fact changes.
   * @param listener - observer receiving the current immutable snapshot.
   * @returns disposer for this observer.
   */
  subscribe(listener: (snapshot: SidebarGlassSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Project a user gesture immediately, then persist it through the Host scope.
   * @param enabled - saved glass preference requested by the user.
   */
  setEnabled(enabled: boolean): void {
    if (this.disposed || !this.snapshot.available || enabled === this.enabled) return
    this.enabled = enabled
    this.publish()
    void this.host.set(SIDEBAR_GLASS_EFFECT_FIELD, enabled)
  }

  /** Stop Host and environment observation and release subscribers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeHost()
    this.disposeEnvironment()
    this.listeners.clear()
  }

  private adopt(): void {
    if (this.disposed) return
    const value = this.host.getSnapshot().value
    if (value !== undefined) this.enabled = value.enabled
    this.publish()
  }

  private publish(): void {
    if (this.disposed) return
    const facts: SidebarMaterialFacts = { enabled: this.enabled, ...this.environment.getFacts() }
    const host = this.host.getSnapshot()
    const available = facts.platform === 'darwin' && host.status === 'ready' && host.writable
    const material = resolveSidebarMaterial({ ...facts, enabled: available && facts.enabled })
    const systemOverride = available && facts.reducedTransparency
    this.revision += 1
    this.snapshot = Object.freeze({ ...facts, available, systemOverride, material, revision: this.revision })
    this.environment.apply(material)
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot)
      } catch (error) {
        console.error('[ui-theme] sidebar glass listener failed:', error)
      }
    }
  }
}
