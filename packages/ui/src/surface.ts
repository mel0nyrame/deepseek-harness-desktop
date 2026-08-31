/** DOM presentation rules shared by the desktop UI contributions. */

export interface DesktopNativeSurfaceState {
  readonly appearance: 'light' | 'dark'
  readonly transparency: 'glass' | 'opaque'
  readonly platform: NodeJS.Platform
  readonly fullscreen: boolean
  readonly focused: boolean
}

export type SidebarMaterial = 'glass-light' | 'glass-dark' | 'opaque'

export interface DesktopSurfaceBodyLike {
  readonly dataset: Record<string, string | undefined>
}

export interface DesktopSurfaceStyleLike {
  id: string
  textContent: string | null
  remove(): void
}

export interface DesktopSurfaceDocumentLike {
  readonly body: DesktopSurfaceBodyLike
  readonly head: { append(element: DesktopSurfaceStyleLike): void }
  createElement(name: 'style'): DesktopSurfaceStyleLike
}

/** Resolve the effective sidebar material after native accessibility overrides. */
export function resolveSidebarMaterial(
  state: DesktopNativeSurfaceState,
  glassEnabled: boolean,
): SidebarMaterial {
  if (!glassEnabled || state.platform !== 'darwin' || state.transparency !== 'glass') return 'opaque'
  return state.appearance === 'dark' ? 'glass-dark' : 'glass-light'
}

/** Project validated native facts and the saved material preference onto the product surface. */
export function applyDesktopSurfaceState(
  body: DesktopSurfaceBodyLike,
  state: DesktopNativeSurfaceState,
  glassEnabled: boolean,
): void {
  body.dataset.dshAppearance = state.appearance
  body.dataset.dshTransparency = state.transparency
  body.dataset.dshPlatform = state.platform
  body.dataset.dshFullscreen = String(state.fullscreen)
  body.dataset.dshFocused = String(state.focused)
  body.dataset.dshSidebarMaterial = resolveSidebarMaterial(state, glassEnabled)
}

/** Stable desktop chrome stylesheet installed and removed with the Client contribution. */
export const DESKTOP_SURFACE_CSS = `
body[data-dsh-platform='darwin'],
body[data-dsh-platform='darwin'] #root {
  background: transparent !important;
}

body[data-dsh-platform='darwin'] [data-slot='conversation.session.header'] > header,
body[data-dsh-platform='darwin'] [data-desktop-sidebar-control-row],
body[data-dsh-platform='darwin'] [data-desktop-sidebar-brand-row],
body[data-dsh-platform='darwin'] [data-window-drag-surface] {
  -webkit-app-region: drag;
  user-select: none;
}

body[data-dsh-platform='darwin'] button,
body[data-dsh-platform='darwin'] a,
body[data-dsh-platform='darwin'] input,
body[data-dsh-platform='darwin'] textarea,
body[data-dsh-platform='darwin'] select,
body[data-dsh-platform='darwin'] [role='button'] {
  -webkit-app-region: no-drag;
}

body[data-dsh-platform='darwin'] [data-slot='sidebar'] > div {
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 68%, transparent) !important;
  border-right: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 62%, transparent);
}

body[data-dsh-platform='darwin'][data-dsh-sidebar-material='opaque'] [data-slot='sidebar'] > div {
  background: var(--dsw-alias-bg-base) !important;
}

body[data-dsh-platform='darwin'][data-dsh-sidebar-material='glass-dark'] [data-slot='sidebar'] > div {
  background: rgba(24, 24, 27, 0.64) !important;
}

body[data-dsh-platform='darwin'][data-dsh-sidebar-material='glass-light'] [data-slot='sidebar'] > div {
  background: rgba(246, 247, 249, 0.66) !important;
}

body[data-dsh-platform='darwin'][data-dsh-focused='false'] [data-slot='sidebar'] > div {
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent) !important;
}

body[data-dsh-platform='darwin'] [data-slot='sidebar'] > div > :first-child {
  visibility: hidden;
}

[data-desktop-window-chrome] {
  display: none;
}

body[data-dsh-platform='darwin'] [data-desktop-window-chrome] {
  display: contents;
}

[data-desktop-sidebar-control-row],
[data-desktop-sidebar-reveal] {
  position: fixed;
  z-index: 40;
}

[data-desktop-sidebar-control-row] {
  top: 0;
  left: 0;
  width: var(--dsh-sidebar-width, 280px);
  height: 60px;
  padding: 0 16px 0 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  pointer-events: none;
}

[data-desktop-sidebar-control-row] button,
[data-desktop-sidebar-reveal] {
  pointer-events: auto;
}

[data-desktop-sidebar-reveal] {
  top: 15px;
  left: 84px;
}

[data-sidebar-collapsed='false'] [data-desktop-sidebar-reveal],
[data-sidebar-collapsed='true'] [data-desktop-sidebar-control-row] {
  display: none;
}

body[data-dsh-fullscreen='true'] [data-desktop-sidebar-control-row] {
  padding-left: 12px;
}

body[data-dsh-fullscreen='true'] [data-desktop-sidebar-reveal] {
  left: 12px;
}

body[data-dsh-platform='darwin'] [data-slot='conversation.session.header'] > header {
  min-height: 48px;
  padding-top: 1.2px;
}

.dsh-desktop-glass-row {
  min-height: 72px;
  padding: 18px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.dsh-desktop-glass-row-text {
  display: grid;
  gap: 4px;
}

.dsh-desktop-glass-row-title {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.dsh-desktop-glass-row-description {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
}

.dsh-desktop-chrome-button {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}

.dsh-desktop-chrome-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dsh-desktop-chrome-brand {
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  letter-spacing: -0.01em;
}
`

/** Install the desktop surface stylesheet and return its exact removal action. */
export function installDesktopSurfaceStyles(document: DesktopSurfaceDocumentLike): () => void {
  const style = document.createElement('style')
  style.id = 'dsh-desktop-surface-styles'
  style.textContent = DESKTOP_SURFACE_CSS
  document.head.append(style)
  return () => { style.remove() }
}
