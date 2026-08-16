import type { BrowserWindowConstructorOptions } from 'electron'

export const MACOS_TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const

/**
 * Windowed control-row inset past the native traffic-light group. The lights
 * start at `MACOS_TRAFFIC_LIGHT_POSITION.x` and span three 12px lights with
 * 8px gaps (16 + 52 = 68px); an 8px gap then puts the 28px toggle's left
 * edge at 76px, of which the sidebar's own 12px padding provides the first
 * 12px. Native full screen hides the lights and returns the row to the
 * sidebar's left content inset.
 */
export const MACOS_CONTROL_ROW_INSET_PX = 64

/** Renderer chrome injected only by the desktop shell, leaving Web presentation unchanged. */
export const DESKTOP_SURFACE_CSS = `
html,
body {
  background: transparent !important;
}

#root {
  position: absolute !important;
  inset: 0 !important;
  height: auto !important;
  background: transparent !important;
}

/* macOS compact chrome: the native window is the drag surface; interactive
   shell regions opt back into pointer events. Other platforms keep their
   native frame and do not receive a synthetic imitation. */
body[data-dsh-platform='darwin'] {
  -webkit-app-region: drag;
}

body[data-dsh-platform='darwin'] button,
body[data-dsh-platform='darwin'] a,
body[data-dsh-platform='darwin'] input,
body[data-dsh-platform='darwin'] select,
body[data-dsh-platform='darwin'] textarea,
body[data-dsh-platform='darwin'] [role='button'],
body[data-dsh-platform='darwin'] [role='link'],
body[data-dsh-platform='darwin'] [contenteditable='true'],
body[data-dsh-platform='darwin'] [data-shell-overlay],
body[data-dsh-platform='darwin'] [data-slot='sidebar.workspaces'] > *,
body[data-dsh-platform='darwin'] [data-slot='sidebar.settings'] > *,
body[data-dsh-platform='darwin'] [data-slot='sidebar.footer.action'] > *,
body[data-dsh-platform='darwin'] [data-slot='conversation'] [data-conversation-scroll],
body[data-dsh-platform='darwin'] [data-slot='conversation'] [data-composer-seat],
body[data-dsh-platform='darwin'] [data-slot='details'] {
  -webkit-app-region: no-drag;
}

/* Compact sidebar header (macOS only): the toggle shares the traffic-light
   row immediately right of the native light group, and the wordmark moves
   to the following row. The sidebar shell keeps the wordmark in the first
   row by default; these rules flip the header under the darwin platform
   fact, so Web and other desktop platforms keep the previous shell. The
   collapsed rail keeps its own geometry (issue #33 replaces the rail). */
body[data-dsh-platform='darwin'] [data-slot='sidebar'] [data-sidebar-brand-inline] {
  display: none !important;
}

body[data-dsh-platform='darwin'] [data-slot='sidebar'] [data-sidebar-control-row] {
  justify-content: flex-start !important;
  height: 28px !important;
  padding: 0 0 0 ${MACOS_CONTROL_ROW_INSET_PX}px !important;
  margin-bottom: 8px !important;
}

body[data-dsh-platform='darwin'] [data-sidebar-collapsed] [data-slot='sidebar'] [data-sidebar-control-row] {
  justify-content: flex-start !important;
  height: 36px !important;
  padding: 0 !important;
  margin-bottom: 12px !important;
}

body[data-dsh-platform='darwin'] [data-slot='sidebar'] [data-sidebar-brand-row] {
  display: flex !important;
  align-items: center !important;
  height: 28px !important;
  padding: 0 !important;
  margin-bottom: 8px !important;
  overflow: hidden !important;
}

/* Native full screen hides the traffic lights; move the sidebar control and
   wordmark rows to the sidebar's own left content inset. */
body[data-dsh-platform='darwin'][data-dsh-fullscreen='true'] [data-slot='sidebar'] [data-sidebar-control-row],
body[data-dsh-platform='darwin'][data-dsh-fullscreen='true'] [data-slot='sidebar'] [data-sidebar-brand-row] {
  padding-left: 0 !important;
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
  readonly platform: NodeJS.Platform
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
export function rendererSurfaceState(
  dark: boolean,
  reducedTransparency: boolean,
  platform: NodeJS.Platform,
): RendererSurfaceState {
  return {
    appearance: dark ? 'dark' : 'light',
    transparency: reducedTransparency ? 'reduced' : 'enabled',
    platform,
  }
}
