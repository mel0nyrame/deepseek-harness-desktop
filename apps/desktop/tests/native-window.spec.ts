import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SURFACE_CSS,
  MACOS_COLLAPSED_HEADER_INSET_PX,
  MACOS_COMPACT_VERTICAL_OFFSET_PX,
  MACOS_CONTROL_ROW_INSET_PX,
  MACOS_FULLSCREEN_HEADER_INSET_PX,
  MACOS_FULLSCREEN_REVEAL_INSET_PX,
  MACOS_REVEAL_INSET_PX,
  MACOS_TRAFFIC_LIGHT_POSITION,
  desktopWindowOptions,
  rendererSurfaceState,
} from '../src/native-window.ts'

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
const appFrameCss = readFileSync(
  new URL('../../../packages/client/ui-layout/src/client/AppFrame.module.css', import.meta.url),
  'utf8',
)
const conversationCss = readFileSync(
  new URL('../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css', import.meta.url),
  'utf8',
)

/** Split a CSS string into [selector, declarations] rule pairs. */
function cssRules(css: string): Array<[string, string]> {
  return css.split('}').map(part => part.trim()).filter(Boolean).map((part) => {
    const open = part.indexOf('{')
    return [part.slice(0, open).trim(), part.slice(open + 1).trim()]
  })
}

describe('native macOS desktop window contract', () => {
  it('configures supported AppKit-backed chrome and active-window vibrancy', () => {
    expect(desktopWindowOptions('darwin')).toMatchObject({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
    })
  })

  it('does not request unsupported macOS effects on other platforms', () => {
    expect(desktopWindowOptions('linux')).toEqual({ backgroundColor: '#f9fafb' })
    expect(desktopWindowOptions('win32')).toEqual({ backgroundColor: '#f9fafb' })
  })

  it.each([
    [false, false, 'darwin', { appearance: 'light', transparency: 'enabled', platform: 'darwin' }],
    [true, false, 'linux', { appearance: 'dark', transparency: 'enabled', platform: 'linux' }],
    [false, true, 'win32', { appearance: 'light', transparency: 'reduced', platform: 'win32' }],
    [true, true, 'darwin', { appearance: 'dark', transparency: 'reduced', platform: 'darwin' }],
  ] as const)('maps native appearance dark=%s reduced=%s platform=%s into renderer state', (dark, reduced, platform, expected) => {
    expect(rendererSurfaceState(dark, reduced, platform)).toEqual(expected)
  })

  it('uses compact macOS chrome without a synthetic 44-pixel title strip', () => {
    expect(MACOS_CONTROL_ROW_INSET_PX).toBe(72)
    expect(MACOS_COMPACT_VERTICAL_OFFSET_PX).toBe(1.2)
    expect(DESKTOP_SURFACE_CSS).not.toContain('body::before')
    expect(DESKTOP_SURFACE_CSS).not.toContain('44px')
    expect(DESKTOP_SURFACE_CSS).toMatch(/#root\s*\{[^}]*inset: 0 !important;/)
    const rules = cssRules(DESKTOP_SURFACE_CSS)

    // Drag/no-drag regions exist and every one is scoped to the darwin
    // platform fact: Windows and Linux keep their native frame untouched.
    const appRegionRules = rules.filter(([, declarations]) => declarations.includes('-webkit-app-region'))
    expect(appRegionRules.length).toBeGreaterThan(0)
    for (const [selector] of appRegionRules) {
      expect(selector).toContain("[data-dsh-platform='darwin']")
    }
    expect(appRegionRules.some(([selector, declarations]) =>
      selector.includes('button') && declarations.includes('-webkit-app-region: no-drag'),
    )).toBe(true)
    expect(appRegionRules.some(([selector, declarations]) =>
      selector.includes('textarea') && declarations.includes('-webkit-app-region: no-drag'),
    )).toBe(true)
    expect(appRegionRules.some(([selector, declarations]) =>
      selector === "body[data-dsh-platform='darwin']" && declarations.includes('-webkit-app-region: drag'),
    )).toBe(false)
    for (const chrome of [
      '[data-conversation-header]',
      '[data-sidebar-control-row]',
      '[data-sidebar-brand-row]',
      '[data-window-drag-surface]',
    ]) {
      expect(appRegionRules.some(([selector, declarations]) =>
        selector.includes(chrome) && declarations.includes('-webkit-app-region: drag'),
      ), `${chrome} must own a real topmost drag region`).toBe(true)
    }
    expect(appRegionRules.some(([selector, declarations]) =>
      selector.includes('[data-conversation-scroll]') && declarations.includes('-webkit-app-region: no-drag'),
    )).toBe(true)
    expect(appRegionRules.some(([selector]) => selector.trim() ===
      "body[data-dsh-platform='darwin'] [data-shell-overlay]"),
    ).toBe(false)

    // Compact header: the toggle clears the native traffic-light group in
    // windowed mode, the inline wordmark is hidden, the brand row is
    // revealed, and full screen returns both rows to the left content inset.
    const compact = rules.find(([selector]) => selector.endsWith('[data-sidebar-control-row]'))
    expect(compact).toBeDefined()
    expect(compact?.[1]).toContain(`padding: 0 0 0 ${MACOS_CONTROL_ROW_INSET_PX}px !important`)
    expect(compact?.[1]).toContain(`transform: translateY(${MACOS_COMPACT_VERTICAL_OFFSET_PX}px) !important`)
    expect(compact?.[1]).toContain('justify-content: flex-start !important')
    expect(compact?.[1]).toContain('height: 28px !important')
    expect(rules.some(([selector, declarations]) =>
      selector.includes('[data-sidebar-brand-inline]') && declarations.includes('display: none !important'),
    )).toBe(true)
    expect(rules.some(([selector, declarations]) =>
      selector.includes('[data-sidebar-brand-row]') && declarations.includes('display: flex !important'),
    )).toBe(true)
    // Full screen returns the sidebar's own control and wordmark rows to the
    // left content inset (the reveal and header rules are asserted separately).
    const fullscreen = rules.filter(([selector]) =>
      selector.includes("data-dsh-fullscreen='true'")
      && (selector.includes('[data-sidebar-control-row]') || selector.includes('[data-sidebar-brand-row]')),
    )
    expect(fullscreen.length).toBeGreaterThan(0)
    for (const [, declarations] of fullscreen) {
      expect(declarations).toContain('padding-left: 0 !important')
    }
  })

  it('positions the collapsed reveal control and clears the conversation header (issue #33)', () => {
    expect(MACOS_REVEAL_INSET_PX).toBe(84)
    expect(MACOS_COLLAPSED_HEADER_INSET_PX).toBe(120)
    const rules = cssRules(DESKTOP_SURFACE_CSS)

    // The collapsed rail override is gone: no rule targets the sidebar's
    // control row under data-sidebar-collapsed (zero-width collapse leaves
    // no rail for the shell to lay out).
    expect(rules.some(([selector]) =>
      selector.includes('[data-sidebar-collapsed]') && selector.includes('[data-sidebar-control-row]'),
    )).toBe(false)

    // Windowed: the reveal control clears the native traffic-light group;
    // full screen returns it to the sidebar's left content inset.
    const reveal = rules.find(([selector]) => selector.endsWith('[data-sidebar-reveal]'))
    expect(reveal).toBeDefined()
    expect(reveal?.[1]).toContain(`left: ${MACOS_REVEAL_INSET_PX}px !important`)
    expect(reveal?.[1]).toContain(`top: ${6 + MACOS_COMPACT_VERTICAL_OFFSET_PX}px !important`)
    const revealFullscreen = rules.find(([selector]) =>
      selector.includes("data-dsh-fullscreen='true'") && selector.endsWith('[data-sidebar-reveal]'),
    )
    expect(revealFullscreen).toBeDefined()
    expect(revealFullscreen?.[1]).toContain(`left: ${MACOS_FULLSCREEN_REVEAL_INSET_PX}px !important`)

    // The conversation header clears the top-left chrome cluster in both
    // states — never the former sidebar width.
    const header = rules.find(([selector]) =>
      selector.includes('[data-sidebar-collapsed]') && selector.endsWith('[data-conversation-header]'),
    )
    expect(header).toBeDefined()
    expect(header?.[1]).toContain(`padding-left: ${MACOS_COLLAPSED_HEADER_INSET_PX}px !important`)
    expect(header?.[1]).toContain(`padding-top: ${4 + MACOS_COMPACT_VERTICAL_OFFSET_PX}px !important`)
    const headerFullscreen = rules.find(([selector]) =>
      selector.includes("data-dsh-fullscreen='true'") && selector.endsWith('[data-conversation-header]'),
    )
    expect(headerFullscreen).toBeDefined()
    expect(headerFullscreen?.[1]).toContain(`padding-left: ${MACOS_FULLSCREEN_HEADER_INSET_PX}px !important`)

    // The shared frame places the 28px reveal at y=6 and the desktop override
    // starts the 32px title row at y=4; both centers are y=20 before the
    // shared compact offset. Chat/Trajectory starts after the 4px tab gap.
    // These are one cross-package geometry contract.
    const appFrameRules = cssRules(appFrameCss)
    const baseReveal = appFrameRules.find(([selector]) => selector.endsWith('.reveal'))
    expect(baseReveal?.[1]).toContain('top: 6px')
    expect(baseReveal?.[1]).toContain('width: 28px')
    expect(baseReveal?.[1]).toContain('height: 28px')
    const conversationRules = cssRules(conversationCss)
    const titleRow = conversationRules.find(([selector]) => selector.endsWith('.titleRow'))
    const tabs = conversationRules.find(([selector]) => selector.endsWith('.tabs'))
    expect(titleRow?.[1]).toContain('min-height: 32px')
    expect(tabs?.[1]).toContain('margin-top: 4px')
    expect(6 + MACOS_COMPACT_VERTICAL_OFFSET_PX + 28 / 2)
      .toBe(4 + MACOS_COMPACT_VERTICAL_OFFSET_PX + 32 / 2)
    expect(4 + MACOS_COMPACT_VERTICAL_OFFSET_PX + 32 + 4).toBe(41.2)
  })

  it('applies the calibrated windowed conversation chrome offsets in both sidebar states', () => {
    const rules = cssRules(DESKTOP_SURFACE_CSS)
    const windowedRule = (target: string, collapsed: boolean) => rules.find(([selector]) =>
      selector.includes(":not([data-dsh-fullscreen='true'])")
      && selector.endsWith(target)
      && selector.includes('[data-sidebar-collapsed]') === collapsed,
    )

    const expandedTitleRow = windowedRule('[data-conversation-title-row]', false)?.[1]
    expect(expandedTitleRow).toContain('position: relative !important')
    expect(expandedTitleRow).toContain('z-index: 1 !important')
    expect(expandedTitleRow).toContain('transform: translateY(-8px) !important')
    expect(windowedRule('[data-conversation-view-tabs]', false)?.[1])
      .toContain('transform: translateY(-10px) !important')
    expect(windowedRule('[data-conversation-header]::after', false)?.[1])
      .toContain('transform: translateY(-10px) !important')
    expect(windowedRule('[data-conversation-title-row]', true)?.[1])
      .toContain('transform: translateY(0) !important')
    expect(windowedRule('[data-conversation-view-tabs]', true)?.[1])
      .toContain('transform: translateY(-4px) !important')
    expect(windowedRule('[data-conversation-header]::after', true)?.[1])
      .toContain('transform: translateY(-4px) !important')
  })

  it('leaves native full-screen traffic-light visibility to AppKit', () => {
    expect(mainSource.includes('setWindowButtonVisibility')).toBe(false)
  })

  it('isolates native material to the sidebar while content columns stay opaque', () => {
    const rules = cssRules(DESKTOP_SURFACE_CSS)
    const sidebarBase = rules.find(([selector]) => selector.endsWith('[data-dsh-sidebar-surface]'))
    expect(sidebarBase?.[0]).toContain("[data-dsh-platform='darwin']")
    expect(sidebarBase?.[1]).toContain('--dsw-specific-sidebar-fill: transparent')

    const material = (name: string) => rules.find(([selector]) =>
      selector.includes(`[data-dsh-sidebar-material='${name}']`)
      && selector.endsWith('[data-dsh-sidebar-surface]'),
    )
    expect(material('glass-light')?.[1]).toContain('background: transparent !important')
    expect(material('glass-dark')?.[1]).toContain('background: transparent !important')
    expect(material('opaque-light')?.[1]).toContain('background: var(--dsw-static-neutral-bluish-50) !important')
    expect(material('opaque-dark')?.[1]).toContain('background: var(--dsw-static-neutral-bluish-900) !important')

    const glassOverlays = rules.find(([selector]) =>
      selector.includes("[data-dsh-sidebar-material^='glass-']")
      && selector.includes('[data-sidebar-new-session]')
      && selector.includes("[aria-selected='true']"),
    )
    expect(glassOverlays?.[1]).toContain('background: var(--dsw-alias-interactive-bg-hover) !important')

    const content = rules.find(([selector]) =>
      selector.includes('[data-dsh-conversation-surface]')
      && selector.includes('[data-dsh-details-surface]'),
    )
    expect(content?.[0]).toContain("[data-dsh-platform='darwin']")
    expect(content?.[1]).toContain('background: var(--dsw-alias-bg-base) !important')
    expect(DESKTOP_SURFACE_CSS).not.toMatch(
      /body\[data-dsh-transparency='enabled'\]\s*\{[^}]*--dsw-alias-bg-base:\s*transparent/,
    )
  })

  it('keeps keyboard focus visible over every native material', () => {
    expect(DESKTOP_SURFACE_CSS).toContain(':focus-visible')
    expect(DESKTOP_SURFACE_CSS).toContain('outline: 2px solid')
  })
})
