import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const output = process.argv.at(-1)
if (output === undefined || !path.isAbsolute(output)) {
  throw new Error('desktop UI composition smoke requires an absolute output directory')
}

const uiRequire = createRequire(path.join(ROOT, 'packages', 'ui', 'package.json'))
const React = uiRequire('react')
const { renderToStaticMarkup } = uiRequire('react-dom/server')
const {
  DESKTOP_SURFACE_CSS,
  applyDesktopSurfaceState,
} = await import(pathToFileURL(path.join(ROOT, 'packages', 'ui', 'lib', 'surface.js')).href)

const officialStyles = []
let sidebarClient
let desktopClient
const passthrough = ({ children }) => children
const icon = ({ size = 16 }) => React.createElement(
  'span',
  { className: 'evidence-icon', style: { width: size, height: size }, 'aria-hidden': 'true' },
  '●',
)
const primitives = new Proxy({}, {
  get: (_target, property) => property === 'Tooltip' ? passthrough : icon,
})
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: element => { officialStyles.push(element.textContent ?? '') } },
}
globalThis.window = {
  setTimeout,
  clearTimeout,
  __ModuleLoader__: {
    load(definition) {
      const value = definition.factory((id) => {
        if (id === 'react') return React
        if (id === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
        if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
        throw new Error(`unexpected published sidebar dependency: ${id}`)
      })
      if (definition.id === '@dsh-desktop/ui') desktopClient = value
      if (definition.id === '@deepseek-ai/dsh-client-ui-sidebar') sidebarClient = value
    },
  },
}

await import(`${pathToFileURL(path.join(ROOT, 'packages', 'ui', 'lib', 'client.js')).href}?visual-evidence`)
if (desktopClient === undefined) throw new Error('desktop UI Client module did not register')
const { applyWithEnvironment } = desktopClient

const bundleRequire = createRequire(path.join(ROOT, 'packages', 'bundle', 'package.json'))
const webAppPackage = bundleRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
const webAppRequire = createRequire(webAppPackage)
const sidebarPackage = webAppRequire.resolve('@deepseek-ai/dsh-client-ui-sidebar/package.json')
await import(`${pathToFileURL(path.join(path.dirname(sidebarPackage), 'lib', 'client.js')).href}?visual-evidence`)
if (sidebarClient === undefined) throw new Error('published sidebar Client module did not register')

let officialSidebar
sidebarClient.apply({
  effect(setup) { setup(); return () => undefined },
  locale: { register: () => () => undefined },
  slots: {
    register(options, component) {
      if (options.name === 'sidebar') officialSidebar = component
      return () => undefined
    },
  },
  layout: { toggleSidebar() {} },
  workspaces: { startSession() {} },
})
if (officialSidebar === undefined) throw new Error('published sidebar slot registration is missing')

const desktopRegistrations = new Map()
const nativeState = {
  appearance: 'dark',
  transparency: 'glass',
  platform: 'darwin',
  fullscreen: false,
  focused: true,
}
const scope = {
  getSnapshot: () => ({ status: 'ready', value: { enabled: true }, writable: true }),
  subscribe: () => () => undefined,
  set: () => Promise.resolve(),
}
applyWithEnvironment({
  effect(setup) { setup(); return () => undefined },
  locale: { register: () => () => undefined },
  settingsScope: { bind: () => scope },
  theme: { getTheme: () => ({ preference: 'system' }) },
  on: () => () => undefined,
  layout: { toggleSidebar() {} },
  slots: {
    inject(_name, setup) { return setup() },
    register(options, component) {
      desktopRegistrations.set(options.id, component)
      return () => undefined
    },
  },
}, {
  nativeTheme: {
    getState: () => nativeState,
    setPreference() {},
    onState: () => () => undefined,
  },
  primitives: {
    BrandWordmark: primitives.BrandWordmark,
    PanelIcon: primitives.IconPanelLeftOutline16,
  },
  document: {
    body: { dataset: {} },
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    head: { append() {} },
  },
})

const DesktopWindowChrome = desktopRegistrations.get('desktop-window-chrome')
const SidebarGlassRow = desktopRegistrations.get('desktop-sidebar-glass')
if (DesktopWindowChrome === undefined || SidebarGlassRow === undefined) {
  throw new Error('desktop UI contribution registrations are missing')
}

const desktopText = key => ({
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.expand': 'Expand sidebar',
  'glass.title': 'Translucent sidebar',
  'glass.description': 'Use the macOS window material behind the sidebar.',
  'glass.reduced': 'Reduce Transparency is enabled in macOS.',
  'glass.unavailable': 'Available in the macOS desktop app.',
})[key] ?? key
const sidebarText = key => ({
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
})[key] ?? key

function workspaceOccupant(wide) {
  return React.createElement('div', { className: 'workspace-list', 'data-official-workspace-list': '' },
    React.createElement('div', { className: 'workspace-title' }, wide ? 'Workspaces' : 'W'),
    React.createElement('div', { className: 'workspace-row' },
      React.createElement('span', null, wide ? 'Project Phoenix' : 'P'),
      React.createElement('span', { 'data-official-workspace-count': '3' }, '3'),
    ),
    wide && React.createElement('div', { className: 'session-row' }, 'Refine native window evidence'),
  )
}

function surfaceBody({ appearance, transparency, collapsed }) {
  const state = { ...nativeState, appearance, transparency }
  const body = { dataset: {} }
  applyDesktopSurfaceState(body, state, true)
  const width = collapsed ? 0 : 350
  const sidebar = React.createElement(officialSidebar, {
    collapsed,
    width: collapsed ? 350 : width,
    startSession() {},
    toggleSidebar() {},
    t: sidebarText,
    renderSlot(name, props) {
      if (name === 'sidebar.workspaces') return workspaceOccupant(props.wide)
      if (name === 'sidebar.settings') return props.wide
        ? React.createElement('div', { className: 'sidebar-settings' }, 'Settings')
        : null
      return null
    },
  })
  const material = body.dataset.dshSidebarMaterial
  const snapshot = {
    available: true,
    enabled: true,
    systemOverride: transparency === 'opaque',
    material,
    state,
    revision: 1,
  }
  const attributes = Object.fromEntries(Object.entries(body.dataset).map(([key, value]) => [
    `data-${key.replaceAll(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`,
    value,
  ]))
  return renderToStaticMarkup(React.createElement('body', attributes,
    React.createElement('div', {
      className: 'evidence-layout',
      'data-sidebar-collapsed': String(collapsed),
      style: { gridTemplateColumns: `${String(width)}px minmax(0, 1fr)`, '--dsh-sidebar-width': `${String(width)}px` },
    },
    React.createElement('aside', { 'data-slot': 'sidebar' }, sidebar),
    React.createElement('main', null,
      React.createElement('div', { 'data-slot': 'conversation.session.header' },
        React.createElement('header', { 'data-window-drag-surface': '' },
          React.createElement('strong', null, collapsed ? 'Sidebar collapsed' : 'Sidebar expanded'),
          React.createElement('button', { type: 'button' }, 'New task'),
        ),
      ),
      React.createElement('section', { className: 'conversation-card' },
        React.createElement('h1', null, 'DeepSeek Harness Desktop'),
        React.createElement('p', null, `${appearance} · ${transparency} · ${material}`),
        React.createElement('div', { className: 'message' }, 'Native window and official sidebar contributions are active.'),
      ),
      React.createElement(SidebarGlassRow, {
        useDesktopSurface: select => select(snapshot),
        setEnabled() {},
        t: desktopText,
      }),
    ),
    React.createElement(DesktopWindowChrome, {
      BrandWordmark: primitives.BrandWordmark,
      PanelIcon: primitives.IconPanelLeftOutline16,
      toggleSidebar() {},
      t: desktopText,
    }),
  )))
}

const HARNESS_CSS = `
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
body { --dsw-alias-bg-base: #f6f7f9; --dsw-alias-border-l1: #cbd2de; --dsw-alias-border-l2: #dce1e9; --dsw-alias-label-primary: #172033; --dsw-alias-label-secondary: #5e6878; --dsw-alias-interactive-bg-hover: rgba(60, 72, 92, .12); --dsw-alias-button-elevated-fill: rgba(255,255,255,.76); --dsw-alias-button-floating-hover: #fff; --dsw-specific-sidebar-fill: #eef1f5; --ds-ease-in-out: ease; --dsh-scrollbar-thumb: transparent; }
body[data-dsh-appearance='dark'] { --dsw-alias-bg-base: #171b24; --dsw-alias-border-l1: #353c49; --dsw-alias-border-l2: #2c3340; --dsw-alias-label-primary: #eef2f8; --dsw-alias-label-secondary: #aeb7c6; --dsw-alias-interactive-bg-hover: rgba(255,255,255,.1); --dsw-alias-button-elevated-fill: rgba(42,48,60,.78); --dsw-alias-button-floating-hover: #343b48; --dsw-specific-sidebar-fill: #1d222d; background: #11151d; color: #eef2f8; }
.evidence-layout { display: grid; height: 100%; background: var(--dsw-alias-bg-base); }
[data-slot='sidebar'] { min-width: 0; overflow: hidden; }
[data-slot='sidebar'] > div { box-sizing: border-box; }
main { min-width: 0; padding: 0 34px 28px; overflow: hidden; }
[data-slot='conversation.session.header'] > header { height: 58px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--dsw-alias-border-l2); }
[data-slot='conversation.session.header'] button { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 12px; color: inherit; background: transparent; }
.conversation-card { margin: 92px auto 42px; max-width: 620px; padding: 28px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 88%, transparent); }
.conversation-card h1 { margin: 0 0 8px; font-size: 24px; }
.conversation-card p { margin: 0 0 24px; color: var(--dsw-alias-label-secondary); }
.message { padding: 18px; border-radius: 12px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.workspace-list { display: grid; gap: 8px; padding: 12px 8px; }
.workspace-title { color: var(--dsw-alias-label-secondary); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
.workspace-row { display: flex; justify-content: space-between; gap: 12px; padding: 8px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.session-row, .sidebar-settings { padding: 8px; color: var(--dsw-alias-label-secondary); }
.evidence-icon { display: inline-flex; align-items: center; justify-content: center; font-size: 8px; }
`

function htmlFor(state) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${HARNESS_CSS}\n${officialStyles.join('\n')}\n${DESKTOP_SURFACE_CSS}</style></head>${surfaceBody(state)}</html>`
}

async function capture(window, state, name) {
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlFor(state))}`)
  await new Promise(resolveWait => setTimeout(resolveWait, 200))
  const evidence = await window.webContents.executeJavaScript(`(() => {
    const layout = document.querySelector('.evidence-layout')
    const count = document.querySelector('[data-official-workspace-count]')
    const newSession = document.querySelector('button[aria-label="New session"]')
    const reveal = document.querySelector('[data-desktop-sidebar-reveal]')
    const collapse = document.querySelector('[data-desktop-sidebar-toggle]')
    const visible = element => element !== null && element.getClientRects().length > 0
    return {
      appearance: document.body.dataset.dshAppearance,
      transparency: document.body.dataset.dshTransparency,
      material: document.body.dataset.dshSidebarMaterial,
      collapsed: layout?.getAttribute('data-sidebar-collapsed'),
      track: layout === null ? null : getComputedStyle(layout).gridTemplateColumns,
      officialNewSession: newSession?.getAttribute('aria-label') ?? null,
      officialCount: count?.textContent?.trim() ?? null,
      revealVisible: visible(reveal),
      collapseVisible: visible(collapse),
    }
  })()`)
  const image = await window.webContents.capturePage()
  const png = image.toPNG()
  if (png.length < 20_000) throw new Error(`desktop UI visual frame ${name} is unexpectedly empty`)
  writeFileSync(path.join(output, `${name}.png`), png)
  return evidence
}

async function run() {
  mkdirSync(output, { recursive: true })
  const window = new BrowserWindow({
    width: 1160,
    height: 700,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  try {
    const frames = []
    frames.push(await capture(window, { appearance: 'dark', transparency: 'glass', collapsed: false }, 'ui-expanded-dark'))
    frames.push(await capture(window, { appearance: 'light', transparency: 'glass', collapsed: true }, 'ui-collapsed-light'))
    frames.push(await capture(window, { appearance: 'light', transparency: 'opaque', collapsed: false }, 'ui-expanded-opaque'))
    console.log(`UI_VISUAL_EVIDENCE ${JSON.stringify(frames)}`)
  } finally {
    window.destroy()
    app.quit()
  }
}

void app.whenReady().then(run).catch((error) => {
  console.error(error)
  app.exit(1)
})
