import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SURFACE_CSS,
  applyDesktopSurfaceState,
  resolveSidebarMaterial,
  type DesktopSurfaceBodyLike,
} from '../packages/ui/src/surface.js'

describe('desktop UI surface contribution', () => {
  it('enables glass only on macOS when the user and accessibility state allow it', () => {
    expect(resolveSidebarMaterial({
      appearance: 'light', transparency: 'glass', platform: 'darwin', fullscreen: false, focused: true,
    }, true)).toBe('glass-light')
    expect(resolveSidebarMaterial({
      appearance: 'dark', transparency: 'glass', platform: 'darwin', fullscreen: false, focused: true,
    }, true)).toBe('glass-dark')
    expect(resolveSidebarMaterial({
      appearance: 'dark', transparency: 'opaque', platform: 'darwin', fullscreen: false, focused: true,
    }, true)).toBe('opaque')
    expect(resolveSidebarMaterial({
      appearance: 'dark', transparency: 'glass', platform: 'linux', fullscreen: false, focused: true,
    }, true)).toBe('opaque')
    expect(resolveSidebarMaterial({
      appearance: 'dark', transparency: 'glass', platform: 'darwin', fullscreen: false, focused: true,
    }, false)).toBe('opaque')
  })

  it('projects reconstructable native state into stable body attributes', () => {
    const body: DesktopSurfaceBodyLike = { dataset: {} }
    applyDesktopSurfaceState(body, {
      appearance: 'dark', transparency: 'glass', platform: 'darwin', fullscreen: true, focused: false,
    }, true)
    expect(body.dataset).toEqual({
      dshAppearance: 'dark',
      dshTransparency: 'glass',
      dshPlatform: 'darwin',
      dshFullscreen: 'true',
      dshFocused: 'false',
      dshSidebarMaterial: 'glass-dark',
    })
  })

  it('anchors drag, no-drag, compact chrome, focus, and material rules to documented slots', () => {
    expect(DESKTOP_SURFACE_CSS).toContain("[data-slot='conversation.session.header']")
    expect(DESKTOP_SURFACE_CSS).toContain("[data-slot='sidebar']")
    expect(DESKTOP_SURFACE_CSS).toContain('[data-desktop-sidebar-control-row]')
    expect(DESKTOP_SURFACE_CSS).toContain('-webkit-app-region: drag')
    expect(DESKTOP_SURFACE_CSS).toContain('-webkit-app-region: no-drag')
    expect(DESKTOP_SURFACE_CSS).toContain("[data-dsh-focused='false']")
    expect(DESKTOP_SURFACE_CSS).toContain("[data-dsh-sidebar-material='opaque']")
  })
})
