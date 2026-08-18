/** Installed-app acceptance journey for the durable macOS sidebar material. */

import type { BrowserWindow } from 'electron'
import { desktopRpc } from './acceptance.ts'
import type { SidebarGlassAcceptancePhase } from './packaged-runtime.ts'
import type { DshSupervisor } from './supervisor.ts'

interface SidebarGlassRendererState {
  readonly enabled: string | null
  readonly material: string | null
  readonly transparency: string | null
  readonly dark: boolean
  readonly overrideVisible: boolean
  readonly surfaces: {
    readonly frame: string | null
    readonly sidebar: string | null
    readonly conversation: string | null
    readonly details: string | null
  }
  readonly overlays: {
    readonly newSession: string | null
    readonly selectedSession: string | null
  }
  readonly nativeTheme: {
    readonly source: 'light' | 'dark' | 'system'
    readonly dark: boolean
  }
}

/** Main-process capabilities shared with the other installed-app journeys. */
export interface SidebarGlassAcceptanceHarness {
  bootWindow(): { window: BrowserWindow; ready: Promise<void> }
  hostPhase(): string
  completeOnboarding(window: BrowserWindow): Promise<void>
  clickAt(window: BrowserWindow, selector: string): Promise<void>
  waitForRenderer(window: BrowserWindow, expression: string, timeoutMs?: number): Promise<void>
  nativeThemeState(): SidebarGlassRendererState['nativeTheme']
  supervisor(): DshSupervisor
  stop(): Promise<void>
}

/** Read the assembled renderer's saved switch and effective surface pixels. */
async function rendererState(
  harness: SidebarGlassAcceptanceHarness,
  window: BrowserWindow,
): Promise<SidebarGlassRendererState> {
  const renderer = await window.webContents.executeJavaScript(`(() => {
    const color = (selector) => {
      const element = document.querySelector(selector);
      return element === null ? null : getComputedStyle(element).backgroundColor;
    };
    const toggle = document.querySelector('[data-sidebar-glass-toggle]');
    return {
      enabled: toggle?.getAttribute('aria-checked') ?? null,
      material: document.body.dataset.dshSidebarMaterial ?? null,
      transparency: document.body.dataset.dshTransparency ?? null,
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      overrideVisible: document.querySelector('[data-sidebar-glass-toggle]')
        ?.closest('div')?.parentElement?.querySelector('[role="status"]') !== null,
      surfaces: {
        frame: color('[data-dsh-frame-surface]'),
        sidebar: color('[data-dsh-sidebar-surface]'),
        conversation: color('[data-dsh-conversation-surface]'),
        details: color('[data-dsh-details-surface]'),
      },
      overlays: {
        newSession: color('[data-sidebar-new-session]'),
        selectedSession: color('[role="treeitem"][aria-selected="true"]'),
      },
    };
  })()`) as Omit<SidebarGlassRendererState, 'nativeTheme'>
  return { ...renderer, nativeTheme: harness.nativeThemeState() }
}

/** Open General settings and wait for the macOS-only Appearance switch. */
async function openSettings(harness: SidebarGlassAcceptanceHarness, window: BrowserWindow): Promise<void> {
  await harness.clickAt(window, "[data-slot='sidebar.settings'] button[aria-haspopup='dialog']")
  await harness.waitForRenderer(window, "document.querySelector('[role=\"dialog\"] [data-sidebar-glass-toggle]') !== null")
}

/** Wait until the Host settings document carries the expected durable value. */
async function waitForPersisted(supervisor: DshSupervisor, expected: boolean): Promise<void> {
  const deadline = Date.now() + 30_000
  let observed: unknown
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const described = await desktopRpc(supervisor, `sidebar-glass-settings-${String(attempt)}`, 'settings.describe', {})
    const namespaces = described['namespaces']
    if (Array.isArray(namespaces)) {
      const view = namespaces.find((candidate: unknown): candidate is Record<string, unknown> => {
        if (typeof candidate !== 'object' || candidate === null)
          return false
        return (candidate as Record<string, unknown>)['ns'] === 'ui-sidebar-glass-macos'
      })
      observed = view?.['value']
      if (typeof observed === 'object' && observed !== null
        && (observed as Record<string, unknown>)['enabled'] === expected) return
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`desktop sidebar glass acceptance: Host never persisted ${String(expected)}; observed ${JSON.stringify(observed)}`)
}

/** Wait until the Host settings document carries the selected application theme. */
async function waitForThemePersisted(
  supervisor: DshSupervisor,
  expected: 'light' | 'dark' | 'system',
): Promise<void> {
  const deadline = Date.now() + 30_000
  let observed: unknown
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const described = await desktopRpc(supervisor, `theme-settings-${String(attempt)}`, 'settings.describe', {})
    const namespaces = described['namespaces']
    if (Array.isArray(namespaces)) {
      const view = namespaces.find((candidate: unknown): candidate is Record<string, unknown> => {
        if (typeof candidate !== 'object' || candidate === null) return false
        return (candidate as Record<string, unknown>)['ns'] === 'ui-theme'
      })
      observed = view?.['value']
      if (typeof observed === 'object' && observed !== null
        && (observed as Record<string, unknown>)['preference'] === expected) return
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`desktop sidebar glass acceptance: Host never persisted theme ${expected}; observed ${JSON.stringify(observed)}`)
}

function assertState(
  state: SidebarGlassRendererState,
  expectedEnabled: boolean,
  expectedMaterial: 'glass' | 'opaque',
): void {
  if (state.enabled !== String(expectedEnabled)) {
    throw new Error(`desktop sidebar glass acceptance: expected switch ${String(expectedEnabled)}, got ${String(state.enabled)}`)
  }
  if (state.material?.startsWith(`${expectedMaterial}-`) !== true) {
    throw new Error(`desktop sidebar glass acceptance: expected ${expectedMaterial} material, got ${String(state.material)}`)
  }
  const transparent = 'rgba(0, 0, 0, 0)'
  if ((state.surfaces.sidebar === transparent) !== (expectedMaterial === 'glass')) {
    throw new Error(`desktop sidebar glass acceptance: sidebar pixels disagree with ${expectedMaterial}: ${String(state.surfaces.sidebar)}`)
  }
  if (state.surfaces.conversation === transparent || state.surfaces.details === transparent) {
    throw new Error(`desktop sidebar glass acceptance: content surface became transparent: ${JSON.stringify(state.surfaces)}`)
  }
  const selectedOverlayInvalid = state.overlays.selectedSession !== null
    && !isTranslucentColor(state.overlays.selectedSession)
  if (expectedMaterial === 'glass'
    && (!isTranslucentColor(state.overlays.newSession) || selectedOverlayInvalid)) {
    throw new Error(`desktop sidebar glass acceptance: sidebar overlays are not translucent: ${JSON.stringify(state.overlays)}`)
  }
}

/** Verify the system accessibility fallback, then restore glass coverage in this acceptance window. */
async function normalizeTransparency(
  harness: SidebarGlassAcceptanceHarness,
  window: BrowserWindow,
  state: SidebarGlassRendererState,
  expectedEnabled: boolean,
): Promise<SidebarGlassRendererState> {
  if (state.transparency !== 'reduced') return state
  assertState(state, expectedEnabled, 'opaque')
  if (expectedEnabled && !state.overrideVisible) {
    throw new Error('desktop sidebar glass acceptance: Reduce Transparency override copy is absent')
  }
  await window.webContents.executeJavaScript("document.body.dataset.dshTransparency = 'enabled'")
  await harness.waitForRenderer(
    window,
    `document.body.dataset.dshSidebarMaterial?.startsWith('${expectedEnabled ? 'glass' : 'opaque'}-')`,
  )
  return rendererState(harness, window)
}

/** Wait until Electron main has applied the selected native theme source. */
async function waitForNativeTheme(
  harness: SidebarGlassAcceptanceHarness,
  expected: 'light' | 'dark' | 'system',
): Promise<void> {
  const deadline = Date.now() + 30_000
  let observed = harness.nativeThemeState()
  while (Date.now() < deadline) {
    observed = harness.nativeThemeState()
    if (observed.source === expected
      && (expected === 'system' || observed.dark === (expected === 'dark'))) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error(`desktop sidebar glass acceptance: native theme did not become ${expected}: ${JSON.stringify(observed)}`)
}

/** Whether a computed color is a visible, non-opaque rgba overlay. */
function isTranslucentColor(color: string | null): boolean {
  const alpha = color?.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*(\d*\.?\d+)\)$/)?.[1]
  if (alpha === undefined) return false
  const value = Number(alpha)
  return value > 0 && value < 1
}

/** Exercise one launch of the installed renderer's three-launch persistence journey. */
export async function acceptSidebarGlass(
  harness: SidebarGlassAcceptanceHarness,
  phase: SidebarGlassAcceptancePhase,
): Promise<void> {
  const { window, ready } = harness.bootWindow()
  await ready
  if (harness.hostPhase() !== 'running') {
    throw new Error(`desktop sidebar glass acceptance: Host did not reach running (${harness.hostPhase()})`)
  }
  window.show()
  window.focus()
  try {
    await harness.waitForRenderer(
      window,
      "document.querySelector('[data-dsh-sidebar-surface]') !== null && document.querySelector('[data-slot=\"sidebar.settings\"]') !== null",
      60_000,
    )
    if (phase === 'default-off') await harness.completeOnboarding(window)
    await openSettings(harness, window)

    await waitForNativeTheme(harness, phase === 'reopen-enabled' ? 'light' : 'system')
    const systemInitial = await rendererState(harness, window)
    const initial = await normalizeTransparency(
      harness,
      window,
      systemInitial,
      phase !== 'reopen-on',
    )
    const systemState = systemInitial === initial ? {} : { systemInitial }
    if (phase === 'default-off') {
      assertState(initial, true, 'glass')
      await harness.clickAt(window, '[data-sidebar-glass-toggle]')
      await harness.waitForRenderer(window, "document.querySelector('[data-sidebar-glass-toggle]')?.getAttribute('aria-checked') === 'false' && document.body.dataset.dshSidebarMaterial?.startsWith('opaque-')")
      await waitForPersisted(harness.supervisor(), false)
      const afterToggle = await rendererState(harness, window)
      assertState(afterToggle, false, 'opaque')
      console.log(`SIDEBAR_GLASS_ACCEPTANCE ${JSON.stringify({ phase, ...systemState, initial, afterToggle })}`)
      return
    }

    if (phase === 'reopen-enabled') {
      assertState(initial, true, 'glass')
      console.log(`SIDEBAR_GLASS_ACCEPTANCE ${JSON.stringify({ phase, ...systemState, initial })}`)
      return
    }

    assertState(initial, false, 'opaque')
    await harness.clickAt(window, '[data-sidebar-glass-toggle]')
    await harness.waitForRenderer(window, "document.querySelector('[data-sidebar-glass-toggle]')?.getAttribute('aria-checked') === 'true' && document.body.dataset.dshSidebarMaterial?.startsWith('glass-')")
    await waitForPersisted(harness.supervisor(), true)
    const afterToggle = await rendererState(harness, window)
    assertState(afterToggle, true, 'glass')

    await harness.clickAt(window, "[data-theme-preference='dark']")
    await harness.waitForRenderer(window, "document.body.hasAttribute('data-ds-dark-theme') && document.body.dataset.dshSidebarMaterial === 'glass-dark'")
    await waitForNativeTheme(harness, 'dark')
    const dark = await rendererState(harness, window)
    assertState(dark, true, 'glass')

    await window.webContents.executeJavaScript("document.body.dataset.dshTransparency = 'reduced'")
    await harness.waitForRenderer(window, "document.body.dataset.dshSidebarMaterial === 'opaque-dark' && document.querySelector('[role=\"status\"]') !== null")
    const reduced = await rendererState(harness, window)
    assertState(reduced, true, 'opaque')
    if (!reduced.overrideVisible) {
      throw new Error('desktop sidebar glass acceptance: Reduce Transparency override copy is absent')
    }

    await window.webContents.executeJavaScript("document.body.dataset.dshTransparency = 'enabled'")
    await harness.waitForRenderer(window, "document.body.dataset.dshSidebarMaterial === 'glass-dark' && document.querySelector('[role=\"status\"]') === null")
    await harness.clickAt(window, "[data-theme-preference='light']")
    await harness.waitForRenderer(window, "!document.body.hasAttribute('data-ds-dark-theme') && document.body.dataset.dshSidebarMaterial === 'glass-light'")
    await waitForNativeTheme(harness, 'light')
    await waitForThemePersisted(harness.supervisor(), 'light')
    const restored = await rendererState(harness, window)
    assertState(restored, true, 'glass')
    console.log(`SIDEBAR_GLASS_ACCEPTANCE ${JSON.stringify({ phase, ...systemState, initial, afterToggle, dark, reduced, restored })}`)
  } finally {
    window.destroy()
    await harness.stop()
  }
}
