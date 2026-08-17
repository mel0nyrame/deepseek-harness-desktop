import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SURFACE_CSS,
  MACOS_COLLAPSED_HEADER_INSET_PX,
  MACOS_CONTROL_ROW_INSET_PX,
  MACOS_FULLSCREEN_HEADER_INSET_PX,
  MACOS_FULLSCREEN_REVEAL_INSET_PX,
  MACOS_REVEAL_INSET_PX,
  MACOS_TRAFFIC_LIGHT_POSITION,
  desktopWindowOptions,
  rendererSurfaceState,
} from '../src/native-window.ts'

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

    // Compact header: the toggle clears the native traffic-light group in
    // windowed mode, the inline wordmark is hidden, the brand row is
    // revealed, and full screen returns both rows to the left content inset.
    const compact = rules.find(([selector]) => selector.endsWith('[data-sidebar-control-row]'))
    expect(compact).toBeDefined()
    expect(compact?.[1]).toContain(`padding: 0 0 0 ${MACOS_CONTROL_ROW_INSET_PX}px !important`)
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
    const headerFullscreen = rules.find(([selector]) =>
      selector.includes("data-dsh-fullscreen='true'") && selector.endsWith('[data-conversation-header]'),
    )
    expect(headerFullscreen).toBeDefined()
    expect(headerFullscreen?.[1]).toContain(`padding-left: ${MACOS_FULLSCREEN_HEADER_INSET_PX}px !important`)
  })

  it('keeps reduced-transparency surfaces opaque and keyboard focus visible', () => {
    expect(DESKTOP_SURFACE_CSS).toMatch(/data-dsh-transparency='reduced'[\s\S]*background: rgb\(249 250 251/)
    expect(DESKTOP_SURFACE_CSS).toMatch(/data-ds-dark-theme[^}]*data-dsh-transparency='reduced'[\s\S]*background: rgb\(15 17 21/)
    expect(DESKTOP_SURFACE_CSS).toContain(':focus-visible')
    expect(DESKTOP_SURFACE_CSS).toContain('outline: 2px solid')
  })
})
