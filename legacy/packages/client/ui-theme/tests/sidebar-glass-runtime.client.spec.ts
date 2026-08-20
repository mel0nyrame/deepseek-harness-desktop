import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarGlassSettings } from '../src/sidebar-glass-settings.ts'
import {
  SidebarGlassRuntime,
  type SidebarMaterialEnvironment,
} from '../src/client/sidebar-glass-runtime.ts'
import type { SidebarMaterial, SidebarMaterialFacts } from '../src/client/sidebar-material.ts'

abstract class RetainingPublisher {
  private listeners = new Set<() => void>()
  constructor(private readonly retainListeners = false) {}
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      if (!this.retainListeners) this.listeners.delete(listener)
    }
  }
  protected publishListeners() {
    for (const listener of this.listeners) listener()
  }
}

class TestScope extends RetainingPublisher implements SettingsScope<SidebarGlassSettings> {
  private snapshot: SettingsScopeSnapshot<SidebarGlassSettings> = {
    status: 'ready', value: { enabled: true }, base: undefined, user: undefined,
    revision: 0, writable: true, mode: 'host',
  }
  readonly set = vi.fn(() => Promise.resolve())
  getSnapshot() { return this.snapshot }
  load() { return Promise.resolve() }
  unset() { return Promise.resolve() }
  publish(enabled: boolean, revision: number) {
    this.snapshot = { ...this.snapshot, value: { enabled }, revision }
    this.publishListeners()
  }
  publishSnapshot(next: Partial<SettingsScopeSnapshot<SidebarGlassSettings>>) {
    this.snapshot = { ...this.snapshot, ...next }
    this.publishListeners()
  }
}

class TestEnvironment extends RetainingPublisher implements SidebarMaterialEnvironment {
  private facts: Omit<SidebarMaterialFacts, 'enabled'> = {
    platform: 'darwin', reducedTransparency: false, colorScheme: 'light',
  }
  material: SidebarMaterial | undefined
  getFacts() { return this.facts }
  apply(material: SidebarMaterial) { this.material = material }
  publish(facts: Partial<Omit<SidebarMaterialFacts, 'enabled'>>) {
    this.facts = { ...this.facts, ...facts }
    this.publishListeners()
  }
}

describe('SidebarGlassRuntime', () => {
  it('applies a user write immediately, then converges on the Host echo', () => {
    const scope = new TestScope()
    const environment = new TestEnvironment()
    const runtime = new SidebarGlassRuntime(scope, environment)

    expect(runtime.getSnapshot()).toMatchObject({ available: true, enabled: true, material: 'glass-light' })
    expect(environment.material).toBe('glass-light')
    runtime.setEnabled(false)
    expect(runtime.getSnapshot()).toMatchObject({ enabled: false, material: 'opaque-light' })
    expect(environment.material).toBe('opaque-light')
    expect(scope.set).toHaveBeenCalledWith('enabled', false)

    scope.publish(true, 2)
    expect(runtime.getSnapshot()).toMatchObject({ enabled: true, material: 'glass-light' })
  })

  it('preserves the preference while system and theme facts change effective material', () => {
    const scope = new TestScope()
    const environment = new TestEnvironment()
    const runtime = new SidebarGlassRuntime(scope, environment)

    environment.publish({ reducedTransparency: true })
    expect(runtime.getSnapshot()).toMatchObject({
      enabled: true, systemOverride: true, material: 'opaque-light',
    })
    environment.publish({ colorScheme: 'dark' })
    expect(runtime.getSnapshot()).toMatchObject({ enabled: true, material: 'opaque-dark' })
    environment.publish({ reducedTransparency: false })
    expect(runtime.getSnapshot()).toMatchObject({ enabled: true, material: 'glass-dark' })
    expect(scope.set).not.toHaveBeenCalled()
  })

  it('keeps the control unavailable and refuses writes without the macOS Host contribution', () => {
    const scope = new TestScope()
    scope.publishSnapshot({ status: 'unavailable', value: undefined, writable: false })
    const environment = new TestEnvironment()
    const runtime = new SidebarGlassRuntime(scope, environment)

    expect(runtime.getSnapshot()).toMatchObject({ available: false, enabled: true, material: 'opaque-light' })
    runtime.setEnabled(false)
    expect(runtime.getSnapshot().enabled).toBe(true)
    expect(scope.set).not.toHaveBeenCalled()
  })

  it('contains a failing subscriber and still notifies later subscribers', () => {
    const scope = new TestScope()
    const environment = new TestEnvironment()
    const runtime = new SidebarGlassRuntime(scope, environment)
    const failure = new Error('broken subscriber')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn()
    runtime.subscribe(() => { throw failure })
    runtime.subscribe(later)

    environment.publish({ colorScheme: 'dark' })

    expect(error).toHaveBeenCalledWith('[ui-theme] sidebar glass listener failed:', failure)
    expect(later).toHaveBeenCalledWith(expect.objectContaining({ material: 'glass-dark' }))
    error.mockRestore()
  })

  it('stops reacting after disposal', () => {
    const scope = new TestScope(true)
    const environment = new TestEnvironment(true)
    const runtime = new SidebarGlassRuntime(scope, environment)
    const before = runtime.getSnapshot()
    runtime.dispose()
    runtime.dispose()
    runtime.setEnabled(false)
    environment.publish({ reducedTransparency: true })
    scope.publish(false, 3)
    expect(runtime.getSnapshot()).toBe(before)
    expect(scope.set).not.toHaveBeenCalled()
  })
})
