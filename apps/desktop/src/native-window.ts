import type { BrowserWindowConstructorOptions } from 'electron'

export const MACOS_TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const

/**
 * Windowed control-row inset past the native traffic-light group. The lights
 * start at `MACOS_TRAFFIC_LIGHT_POSITION.x` and span three 12px lights with
 * 8px gaps (16 + 52 = 68px); a 16px gap then puts the 28px toggle's left
 * edge at 84px, of which the sidebar's own 12px padding provides the first
 * 12px. Native full screen auto-hides the lights and returns the row to the
 * sidebar's left content inset.
 */
export const MACOS_CONTROL_ROW_INSET_PX = 72

/** Shared subpixel vertical adjustment for the compact macOS chrome alignment. */
export const MACOS_COMPACT_VERTICAL_OFFSET_PX = 1.2

/** Collapsed reveal-control left inset (windowed): the toggle's own left edge
 * (72px row inset + 12px sidebar content padding). */
export const MACOS_REVEAL_INSET_PX = 84

/** Native full screen: the reveal control returns to the sidebar's left content inset. */
export const MACOS_FULLSCREEN_REVEAL_INSET_PX = 12

/** Conversation-header clearance while the sidebar is collapsed (windowed):
 * the reveal control spans 84..112, the title clears it with an 8px gap —
 * the top-left chrome cluster, never the former sidebar width. */
export const MACOS_COLLAPSED_HEADER_INSET_PX = 120

/** Full-screen header clearance: the reveal control spans 12..40, plus 8px gap. */
export const MACOS_FULLSCREEN_HEADER_INSET_PX = 48

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
   row to the right of the native light group with intentional separation,
   and the wordmark moves to the following row. The sidebar shell keeps the
   wordmark in the first row by default; these rules flip the header under
   the darwin platform fact, so Web and other desktop platforms keep the
   previous shell. */
body[data-dsh-platform='darwin'] [data-slot='sidebar'] [data-sidebar-brand-inline] {
  display: none !important;
}

body[data-dsh-platform='darwin'] [data-slot='sidebar'] [data-sidebar-control-row] {
  justify-content: flex-start !important;
  height: 28px !important;
  padding: 0 0 0 ${MACOS_CONTROL_ROW_INSET_PX}px !important;
  margin-bottom: 8px !important;
  transform: translateY(${MACOS_COMPACT_VERTICAL_OFFSET_PX}px) !important;
}

body[data-dsh-platform='darwin'] [data-slot='sidebar'] [data-sidebar-brand-row] {
  display: flex !important;
  align-items: center !important;
  height: 28px !important;
  padding: 0 !important;
  margin-bottom: 8px !important;
  overflow: hidden !important;
}

/* Native full screen auto-hides the traffic lights; move the sidebar control
   and wordmark rows to the sidebar's own left content inset. */
body[data-dsh-platform='darwin'][data-dsh-fullscreen='true'] [data-slot='sidebar'] [data-sidebar-control-row],
body[data-dsh-platform='darwin'][data-dsh-fullscreen='true'] [data-slot='sidebar'] [data-sidebar-brand-row] {
  padding-left: 0 !important;
}

/* Windowed conversation chrome keeps the title row, view tabs, and divider
   independently aligned. The title-row hook includes its adjacent actions
   and right-edge utilities, so the complete row moves as one unit. */
body[data-dsh-platform='darwin']:not([data-dsh-fullscreen='true'])
[data-slot='conversation'] [data-conversation-title-row] {
  transform: translateY(-8px) !important;
}

body[data-dsh-platform='darwin']:not([data-dsh-fullscreen='true'])
[data-slot='conversation'] [data-conversation-view-tabs] {
  transform: translateY(-10px) !important;
}

body[data-dsh-platform='darwin']:not([data-dsh-fullscreen='true'])
[data-slot='conversation'] [data-conversation-header]::after {
  transform: translateY(-10px) !important;
}

body[data-dsh-platform='darwin']:not([data-dsh-fullscreen='true'])
[data-sidebar-collapsed] [data-slot='conversation'] [data-conversation-title-row] {
  transform: translateY(0) !important;
}

body[data-dsh-platform='darwin']:not([data-dsh-fullscreen='true'])
[data-sidebar-collapsed] [data-slot='conversation'] [data-conversation-view-tabs] {
  transform: translateY(-4px) !important;
}

body[data-dsh-platform='darwin']:not([data-dsh-fullscreen='true'])
[data-sidebar-collapsed] [data-slot='conversation'] [data-conversation-header]::after {
  transform: translateY(-4px) !important;
}

/* Zero-width collapse (issue #33): the frame's reveal control is the only
   sidebar affordance while collapsed, positioned outside the zero-width
   sidebar subtree. Windowed it clears the native traffic-light group; native
   full screen auto-hides the lights and returns it to the sidebar's left
   content inset. The conversation header clears the same top-left chrome
   cluster and keeps its title aligned with the reveal control; the
   collapsed track reclaimed the former sidebar width, so only this cluster
   is avoided. */
body[data-dsh-platform='darwin'] [data-sidebar-reveal] {
  left: ${MACOS_REVEAL_INSET_PX}px !important;
  top: ${6 + MACOS_COMPACT_VERTICAL_OFFSET_PX}px !important;
}

body[data-dsh-platform='darwin'][data-dsh-fullscreen='true'] [data-sidebar-reveal] {
  left: ${MACOS_FULLSCREEN_REVEAL_INSET_PX}px !important;
}

body[data-dsh-platform='darwin'] [data-sidebar-collapsed] [data-slot='conversation'] [data-conversation-header] {
  padding-left: ${MACOS_COLLAPSED_HEADER_INSET_PX}px !important;
  padding-top: ${4 + MACOS_COMPACT_VERTICAL_OFFSET_PX}px !important;
}

body[data-dsh-platform='darwin'][data-dsh-fullscreen='true'] [data-sidebar-collapsed] [data-slot='conversation'] [data-conversation-header] {
  padding-left: ${MACOS_FULLSCREEN_HEADER_INSET_PX}px !important;
}

/* The native material belongs to one stable layout surface. Descendants use
   transparent sidebar tokens so hover/selection treatments remain overlays;
   conversation and details keep the normal opaque application background. */
body[data-dsh-platform='darwin'] [data-dsh-frame-surface] {
  background: transparent !important;
}

body[data-dsh-platform='darwin'] [data-dsh-sidebar-surface] {
  --dsw-specific-sidebar-fill: transparent;
  background: var(--dsw-alias-bg-base) !important;
}

body[data-dsh-platform='darwin'][data-dsh-sidebar-material='glass-light'] [data-dsh-sidebar-surface],
body[data-dsh-platform='darwin'][data-dsh-sidebar-material='glass-dark'] [data-dsh-sidebar-surface] {
  background: transparent !important;
}

body[data-dsh-platform='darwin'][data-dsh-sidebar-material^='glass-'] [data-sidebar-new-session],
body[data-dsh-platform='darwin'][data-dsh-sidebar-material^='glass-'] [role='treeitem'][aria-selected='true'] {
  background: var(--dsw-alias-interactive-bg-hover) !important;
}

body[data-dsh-platform='darwin'][data-dsh-sidebar-material^='glass-'] [data-sidebar-new-session]:hover {
  background: var(--dsw-alias-interactive-bg-hover-accent) !important;
}

body[data-dsh-platform='darwin'][data-dsh-sidebar-material='opaque-light'] [data-dsh-sidebar-surface] {
  background: var(--dsw-static-neutral-bluish-50) !important;
}

body[data-dsh-platform='darwin'][data-dsh-sidebar-material='opaque-dark'] [data-dsh-sidebar-surface] {
  background: var(--dsw-static-neutral-bluish-900) !important;
}

body[data-dsh-platform='darwin'] [data-dsh-conversation-surface],
body[data-dsh-platform='darwin'] [data-dsh-details-surface] {
  background: var(--dsw-alias-bg-base) !important;
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
