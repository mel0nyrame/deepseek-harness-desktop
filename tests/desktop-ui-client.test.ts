import { describe, expect, it, vi } from 'vitest'
import {
  DesktopWindowChrome,
  applyWithEnvironment,
  inject,
  type DesktopUiClientEnvironment,
} from '../packages/ui/src/client.js'
import type { NativeThemeBridgeLike, SidebarGlassSettingsScopeLike } from '../packages/ui/src/runtime.js'
import type { DesktopNativeSurfaceState } from '../packages/ui/src/surface.js'

function BrandWordmark() { return null }
function PanelIcon() { return null }

class FakeScope implements SidebarGlassSettingsScopeLike {
  private readonly listeners = new Set<() => void>()
  readonly snapshot = { status: 'ready', value: { enabled: true }, writable: true }
  readonly set = vi.fn(() => Promise.resolve())
  getSnapshot() { return this.snapshot }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  listenerCount(): number { return this.listeners.size }
}

class FakeNativeTheme implements NativeThemeBridgeLike {
  private readonly listeners = new Set<(state: DesktopNativeSurfaceState) => void>()
  readonly preferences: string[] = []
  getState(): DesktopNativeSurfaceState {
    return {
      appearance: 'light', transparency: 'glass', platform: 'darwin', fullscreen: false, focused: true,
    }
  }
  setPreference(preference: 'light' | 'dark' | 'system'): void { this.preferences.push(preference) }
  onState(listener: (state: DesktopNativeSurfaceState) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  listenerCount(): number { return this.listeners.size }
}

interface ElementNode {
  readonly type?: unknown
  readonly props?: Record<string, unknown>
}

function elementNodes(value: unknown): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap(elementNodes)
  if (typeof value !== 'object' || value === null) return []
  const element = value as ElementNode
  return [element, ...elementNodes(element.props?.children)]
}

describe('desktop UI Client contribution', () => {
  it('routes both visible sidebar controls through the official layout action', () => {
    const toggleSidebar = vi.fn()
    const chrome = DesktopWindowChrome({
      BrandWordmark,
      PanelIcon,
      toggleSidebar,
      t: (key: string) => key === 'sidebar.collapse' ? 'Collapse sidebar' : 'Expand sidebar',
    } as never)
    const buttons = elementNodes(chrome).filter(node => node.type === 'button')
    expect(buttons.map(button => button.props?.['aria-label'])).toEqual([
      'Collapse sidebar',
      'Expand sidebar',
    ])
    expect(buttons[0]?.props?.['data-desktop-sidebar-toggle']).toBe('')
    expect(buttons.map(button => button.props?.children).every(child => (
      typeof child === 'object' && child !== null
    ))).toBe(true)
    const nodes = elementNodes(chrome)
    const controlRow = nodes.find(node => node.props?.['data-desktop-sidebar-control-row'] === '')
    const brandRow = nodes.find(node => node.props?.['data-desktop-sidebar-brand-row'] === '')
    expect(controlRow).toBeDefined()
    expect(brandRow).toMatchObject({
      props: { role: 'img', 'aria-label': 'deepseek HARNESS' },
    })
    expect(elementNodes(controlRow).includes(brandRow as ElementNode)).toBe(false)
    expect(brandRow?.props?.children).toEqual(expect.objectContaining({ type: expect.any(Function) }))
    for (const button of buttons) {
      const onClick = button.props?.onClick
      if (typeof onClick !== 'function') throw new Error('desktop sidebar button has no click action')
      onClick()
    }
    expect(toggleSidebar).toHaveBeenCalledTimes(2)
  })

  it('uses additive slots and releases styles, state observers, locale, events, and entries', () => {
    const scope = new FakeScope()
    const nativeTheme = new FakeNativeTheme()
    const body = { dataset: {} as Record<string, string | undefined> }
    const removedStyle = vi.fn()
    const appended: unknown[] = []
    const environment: DesktopUiClientEnvironment = {
      nativeTheme,
      primitives: { BrandWordmark, PanelIcon },
      document: {
        body,
        createElement() { return { id: '', textContent: '', remove: removedStyle } },
        head: { append(element) { appended.push(element) } },
      },
    }
    const registrations: Array<{ options: Record<string, unknown>; component: unknown; dispose: ReturnType<typeof vi.fn> }> = []
    const disposers: Array<() => void> = []
    const localeDispose = vi.fn()
    const eventDispose = vi.fn()
    const ctx = {
      effect(setup: () => void | (() => void)) {
        const dispose = setup()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => undefined
      },
      locale: { register: vi.fn(() => localeDispose) },
      settingsScope: { bind: vi.fn(() => scope) },
      theme: { getTheme: () => ({ preference: 'system' }) },
      on: vi.fn(() => eventDispose),
      layout: { toggleSidebar: vi.fn() },
      slots: {
        inject(_name: string, setup: () => () => void) { return setup() },
        register(options: Record<string, unknown>, component: unknown) {
          const dispose = vi.fn()
          registrations.push({ options, component, dispose })
          return dispose
        },
      },
    }

    applyWithEnvironment(ctx as never, environment)

    expect(inject).toEqual(['slots', 'locale', 'settingsScope', 'theme', 'layout'])
    expect(registrations.map(registration => [registration.options.name, registration.options.id])).toEqual([
      ['shell.overlay', 'desktop-window-chrome'],
      ['settings.general.item', 'desktop-sidebar-glass'],
    ])
    expect(nativeTheme.preferences).toEqual(['system'])
    expect(body.dataset).toMatchObject({ dshPlatform: 'darwin', dshSidebarMaterial: 'glass-light' })
    expect(appended).toHaveLength(1)

    for (const dispose of disposers.toReversed()) dispose()
    expect(registrations.every(registration => registration.dispose.mock.calls.length === 1)).toBe(true)
    expect(localeDispose).toHaveBeenCalledOnce()
    expect(eventDispose).toHaveBeenCalledOnce()
    expect(removedStyle).toHaveBeenCalledOnce()
    expect(scope.listenerCount() + nativeTheme.listenerCount()).toBe(0)
  })
})
