import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { acceptSidebarGlass, type SidebarGlassAcceptanceHarness } from '../src/sidebar-glass-acceptance.ts'
import type { DshSupervisor } from '../src/supervisor.ts'

const acceptance = vi.hoisted(() => ({
  desktopRpc: vi.fn(),
}))

vi.mock('../src/acceptance.ts', () => ({ desktopRpc: acceptance.desktopRpc }))

describe('sidebar glass installed-app acceptance', () => {
  it('honors a reduced-transparency startup before exercising the glass path', async () => {
    const state = {
      enabled: 'true',
      material: 'opaque-light',
      transparency: 'reduced',
      dark: false,
      overrideVisible: true,
      surfaces: {
        frame: 'rgba(0, 0, 0, 0)',
        sidebar: 'rgb(242, 242, 242)',
        conversation: 'rgb(255, 255, 255)',
        details: 'rgb(255, 255, 255)',
      },
      overlays: {
        newSession: 'rgba(0, 0, 0, 0.08)',
        selectedSession: null,
      },
    }
    const executeJavaScript = vi.fn(async (script: string): Promise<unknown> => {
      if (script.includes('const color =')) return structuredClone(state)
      if (script === "document.body.dataset.dshTransparency = 'enabled'") {
        state.transparency = 'enabled'
        state.material = 'glass-light'
        state.overrideVisible = false
        state.surfaces.sidebar = 'rgba(0, 0, 0, 0)'
      }
      return undefined
    })
    const window = {
      webContents: { executeJavaScript },
      show: vi.fn(),
      focus: vi.fn(),
      destroy: vi.fn(),
    } as unknown as BrowserWindow
    const stop = vi.fn(async () => {})
    const harness: SidebarGlassAcceptanceHarness = {
      bootWindow: () => ({ window, ready: Promise.resolve() }),
      hostPhase: () => 'running',
      completeOnboarding: async () => {},
      clickAt: async (_window, selector) => {
        if (selector !== '[data-sidebar-glass-toggle]') return
        state.enabled = 'false'
        state.material = 'opaque-light'
        state.surfaces.sidebar = 'rgb(242, 242, 242)'
      },
      waitForRenderer: async () => {},
      nativeThemeState: () => ({ source: 'system', dark: false }),
      supervisor: () => ({}) as DshSupervisor,
      stop,
    }
    acceptance.desktopRpc.mockResolvedValue({
      namespaces: [{ ns: 'ui-sidebar-glass-macos', value: { enabled: false } }],
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await expect(acceptSidebarGlass(harness, 'default-off')).resolves.toBeUndefined()
      expect(executeJavaScript).toHaveBeenCalledWith("document.body.dataset.dshTransparency = 'enabled'")
      expect(stop).toHaveBeenCalledOnce()
    } finally {
      log.mockRestore()
    }
  })

  it('waits for the light preference to persist before closing the journey', async () => {
    let nativeTheme: 'light' | 'dark' | 'system' = 'system'
    const state = {
      enabled: 'false',
      material: 'opaque-light',
      transparency: 'enabled',
      dark: false,
      overrideVisible: false,
      surfaces: {
        frame: 'rgba(0, 0, 0, 0)',
        sidebar: 'rgb(242, 242, 242)',
        conversation: 'rgb(255, 255, 255)',
        details: 'rgb(255, 255, 255)',
      },
      overlays: {
        newSession: 'rgba(0, 0, 0, 0.08)',
        selectedSession: null,
      },
    }
    const executeJavaScript = vi.fn(async (script: string): Promise<unknown> => {
      if (script.includes('const color =')) return structuredClone(state)
      if (script === "document.body.dataset.dshTransparency = 'reduced'") {
        state.transparency = 'reduced'
        state.material = 'opaque-dark'
        state.overrideVisible = true
        state.surfaces.sidebar = 'rgb(31, 31, 31)'
      }
      if (script === "document.body.dataset.dshTransparency = 'enabled'") {
        state.transparency = 'enabled'
        state.material = 'glass-dark'
        state.overrideVisible = false
        state.surfaces.sidebar = 'rgba(0, 0, 0, 0)'
      }
      return undefined
    })
    const window = {
      webContents: { executeJavaScript },
      show: vi.fn(),
      focus: vi.fn(),
      destroy: vi.fn(),
    } as unknown as BrowserWindow
    const stop = vi.fn(async () => {})
    const harness: SidebarGlassAcceptanceHarness = {
      bootWindow: () => ({ window, ready: Promise.resolve() }),
      hostPhase: () => 'running',
      completeOnboarding: async () => {},
      clickAt: async (_window, selector) => {
        if (selector === '[data-sidebar-glass-toggle]') {
          state.enabled = 'true'
          state.material = 'glass-light'
          state.surfaces.sidebar = 'rgba(0, 0, 0, 0)'
        }
        if (selector === "[data-theme-preference='dark']") {
          nativeTheme = 'dark'
          state.dark = true
          state.material = 'glass-dark'
        }
        if (selector === "[data-theme-preference='light']") {
          nativeTheme = 'light'
          state.dark = false
          state.material = 'glass-light'
        }
      },
      waitForRenderer: async () => {},
      nativeThemeState: () => ({ source: nativeTheme, dark: nativeTheme === 'dark' }),
      supervisor: () => ({}) as DshSupervisor,
      stop,
    }
    let persistTheme!: () => void
    const themePersisted = new Promise<void>((resolve) => { persistTheme = resolve })
    acceptance.desktopRpc.mockImplementation(async (_supervisor, id: string) => {
      if (id.startsWith('sidebar-glass-settings-')) {
        return { namespaces: [{ ns: 'ui-sidebar-glass-macos', value: { enabled: true } }] }
      }
      await themePersisted
      return { namespaces: [{ ns: 'ui-theme', value: { preference: 'light' } }] }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      const accepting = acceptSidebarGlass(harness, 'reopen-on')
      await vi.waitFor(() => {
        expect(nativeTheme).toBe('light')
      })
      expect(stop).not.toHaveBeenCalled()
      persistTheme()
      await accepting
      expect(stop).toHaveBeenCalledOnce()
    } finally {
      log.mockRestore()
    }
  })
})
