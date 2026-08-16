import type { BrowserWindowConstructorOptions } from 'electron'

export const MACOS_TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const

/** Renderer chrome injected only by the desktop shell, leaving Web presentation unchanged. */
export const DESKTOP_SURFACE_CSS = `
html,
body {
  background: transparent !important;
}

#root {
  position: absolute !important;
  inset: 44px 0 0 !important;
  height: auto !important;
  background: transparent !important;
}

body::before {
  content: '';
  position: fixed;
  inset: 0 0 auto;
  height: 44px;
  z-index: 2147483647;
  -webkit-app-region: drag;
}

button,
a,
input,
select,
textarea,
[role='button'],
[role='link'],
[contenteditable='true'],
[data-shell-overlay] {
  -webkit-app-region: no-drag;
}

body[data-dsh-transparency='reduced'] {
  background: rgb(249 250 251 / 0.98) !important;
}

body[data-ds-dark-theme][data-dsh-transparency='reduced'] {
  background: rgb(15 17 21 / 0.98) !important;
}

body[data-dsh-transparency='enabled'] {
  --dsw-alias-bg-base: transparent;
}

:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #3964fe) !important;
  outline-offset: 2px;
}
`

export interface RendererSurfaceState {
  readonly appearance: 'light' | 'dark'
  readonly transparency: 'enabled' | 'reduced'
}

/** Native window options are explicit so acceptance can inspect the real contract. */
export function desktopWindowOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform !== 'darwin') return { backgroundColor: '#f9fafb' }
  return {
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
  }
}

/** Translate native appearance/accessibility state into renderer-owned attributes. */
export function rendererSurfaceState(dark: boolean, reducedTransparency: boolean): RendererSurfaceState {
  return {
    appearance: dark ? 'dark' : 'light',
    transparency: reducedTransparency ? 'reduced' : 'enabled',
  }
}
