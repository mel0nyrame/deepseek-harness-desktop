import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SURFACE_CSS,
  MACOS_TRAFFIC_LIGHT_POSITION,
  desktopWindowOptions,
  rendererSurfaceState,
} from '../src/native-window.ts'

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
    [false, false, { appearance: 'light', transparency: 'enabled' }],
    [true, false, { appearance: 'dark', transparency: 'enabled' }],
    [false, true, { appearance: 'light', transparency: 'reduced' }],
    [true, true, { appearance: 'dark', transparency: 'reduced' }],
  ] as const)('maps native appearance dark=%s reduced=%s into renderer state', (dark, reduced, expected) => {
    expect(rendererSurfaceState(dark, reduced)).toEqual(expected)
  })

  it('defines a dedicated drag strip and excludes every interactive control', () => {
    expect(DESKTOP_SURFACE_CSS).toContain('-webkit-app-region: drag')
    expect(DESKTOP_SURFACE_CSS).toContain('-webkit-app-region: no-drag')
    expect(DESKTOP_SURFACE_CSS).toContain('button')
    expect(DESKTOP_SURFACE_CSS).toContain('textarea')
  })

  it('keeps reduced-transparency surfaces opaque and keyboard focus visible', () => {
    expect(DESKTOP_SURFACE_CSS).toMatch(/data-dsh-transparency='reduced'[\s\S]*background: rgb\(249 250 251/)
    expect(DESKTOP_SURFACE_CSS).toMatch(/data-ds-dark-theme[^}]*data-dsh-transparency='reduced'[\s\S]*background: rgb\(15 17 21/)
    expect(DESKTOP_SURFACE_CSS).toContain(':focus-visible')
    expect(DESKTOP_SURFACE_CSS).toContain('outline: 2px solid')
  })
})
