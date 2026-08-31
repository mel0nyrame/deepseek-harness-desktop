import { describe, expect, it, vi } from 'vitest'
import {
  DesktopSurfaceRuntime,
  type NativeThemeBridgeLike,
  type SidebarGlassSettingsScopeLike,
} from '../packages/ui/src/runtime.js'
import type { DesktopNativeSurfaceState, DesktopSurfaceBodyLike } from '../packages/ui/src/surface.js'

class FakeScope implements SidebarGlassSettingsScopeLike {
  private readonly listeners = new Set<() => void>()
  snapshot = {
    status: 'ready' as const,
    value: { enabled: true },
    writable: true,
  }
  readonly set = vi.fn(() => Promise.resolve())
  getSnapshot() { return this.snapshot }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  publish(enabled: boolean): void {
    this.snapshot = { ...this.snapshot, value: { enabled } }
    for (const listener of this.listeners) listener()
  }
  listenerCount(): number { return this.listeners.size }
}

class FakeNativeTheme implements NativeThemeBridgeLike {
  private readonly listeners = new Set<(state: DesktopNativeSurfaceState) => void>()
  state: DesktopNativeSurfaceState = {
    appearance: 'light', transparency: 'glass', platform: 'darwin', fullscreen: false, focused: true,
  }
  readonly preferences: string[] = []
  getState(): DesktopNativeSurfaceState { return this.state }
  setPreference(preference: 'light' | 'dark' | 'system'): void { this.preferences.push(preference) }
  onState(listener: (state: DesktopNativeSurfaceState) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  publish(state: Partial<DesktopNativeSurfaceState>): void {
    this.state = { ...this.state, ...state }
    for (const listener of this.listeners) listener(this.state)
  }
  listenerCount(): number { return this.listeners.size }
}

describe('DesktopSurfaceRuntime', () => {
  it('projects the saved preference immediately and converges on Host updates', () => {
    const scope = new FakeScope()
    const nativeTheme = new FakeNativeTheme()
    const body: DesktopSurfaceBodyLike = { dataset: {} }
    const runtime = new DesktopSurfaceRuntime(scope, nativeTheme, body)

    expect(runtime.getSnapshot()).toMatchObject({
      available: true, enabled: true, systemOverride: false, material: 'glass-light',
    })
    expect(body.dataset.dshSidebarMaterial).toBe('glass-light')
    runtime.setEnabled(false)
    expect(runtime.getSnapshot()).toMatchObject({ enabled: false, material: 'opaque' })
    expect(scope.set).toHaveBeenCalledWith('enabled', false)
    scope.publish(true)
    expect(runtime.getSnapshot()).toMatchObject({ enabled: true, material: 'glass-light' })
  })

  it('keeps the saved preference while Reduce Transparency overrides its material', () => {
    const scope = new FakeScope()
    const nativeTheme = new FakeNativeTheme()
    const body: DesktopSurfaceBodyLike = { dataset: {} }
    const runtime = new DesktopSurfaceRuntime(scope, nativeTheme, body)

    nativeTheme.publish({ transparency: 'opaque' })
    expect(runtime.getSnapshot()).toMatchObject({
      enabled: true, systemOverride: true, material: 'opaque',
    })
    nativeTheme.publish({ appearance: 'dark', transparency: 'glass', fullscreen: true, focused: false })
    expect(runtime.getSnapshot()).toMatchObject({
      enabled: true, systemOverride: false, material: 'glass-dark',
    })
    expect(body.dataset).toMatchObject({
      dshAppearance: 'dark', dshFullscreen: 'true', dshFocused: 'false', dshSidebarMaterial: 'glass-dark',
    })
    expect(scope.set).not.toHaveBeenCalled()
  })

  it('stops reacting and writing after idempotent disposal', () => {
    const scope = new FakeScope()
    const nativeTheme = new FakeNativeTheme()
    const body: DesktopSurfaceBodyLike = { dataset: {} }
    const runtime = new DesktopSurfaceRuntime(scope, nativeTheme, body)
    const before = runtime.getSnapshot()

    runtime.dispose()
    runtime.dispose()
    runtime.setEnabled(false)
    scope.publish(false)
    nativeTheme.publish({ appearance: 'dark' })
    expect(runtime.getSnapshot()).toBe(before)
    expect(scope.set).not.toHaveBeenCalled()
    expect(scope.listenerCount() + nativeTheme.listenerCount()).toBe(0)
  })
})
