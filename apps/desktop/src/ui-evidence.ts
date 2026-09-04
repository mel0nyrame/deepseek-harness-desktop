/** Keyless evidence journey through the real composed desktop Client. */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { screen, type BrowserWindow } from 'electron'
import { captureStableFrame } from './frame-capture.js'
import { isRequestedWindowSizeSettled } from './native-window.js'
import { TERMINAL_TRACER_PROMPT } from './tracer-contract.js'

const REQUIRED_CLIENT_MODULES = [
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@dsh-desktop/connection',
  '@dsh-desktop/ui',
] as const

async function waitFor(
  window: BrowserWindow,
  expression: string,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ready = await window.webContents.executeJavaScript(`Boolean(${expression})`) as unknown
    if (ready === true) return
    if (Date.now() > deadline) {
      const diagnostic = await window.webContents.executeJavaScript(`(() => ({
        text: document.body.innerText.slice(0, 1500),
        input: document.querySelector('textarea')?.value,
        phase: document.querySelector('textarea')?.getAttribute('data-phase'),
        tools: [...document.querySelectorAll('[data-tool]')].map(row => ({
          tool: row.getAttribute('data-tool'), state: row.getAttribute('data-state'),
        })),
      }))()`)
      throw new Error(`desktop UI evidence timed out waiting for ${label}: ${JSON.stringify(diagnostic)}`)
    }
    await new Promise(done => setTimeout(done, 50))
  }
}

interface CapturedFrame {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

interface VisualSession {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly reply: string
}

interface ResponsiveLayoutState {
  readonly window: { readonly width: number; readonly height: number }
  readonly fullscreen: boolean
  readonly collapsed: boolean
  readonly sidebarWidth: number
  readonly declaredSidebarWidth: number
  readonly control: 'collapse' | 'reveal'
  readonly controlLeft: number
  readonly headerPaddingLeft: number
  readonly tabsLeft: number | null
}

interface ResponsiveEvidence {
  readonly expanded: ResponsiveLayoutState
  readonly collapsed: ResponsiveLayoutState
  readonly narrowCollapsed: ResponsiveLayoutState
  readonly narrowReopened: ResponsiveLayoutState
  readonly resizedExpanded: ResponsiveLayoutState
  readonly fullscreenCollapsed: ResponsiveLayoutState
}

const VISUAL_SESSIONS: readonly VisualSession[] = [
  {
    id: 'visual-review-desktop-experience',
    title: 'Review desktop experience',
    prompt: 'Prepare the visual reference for the desktop experience review.',
    reply: 'VISUAL_REPLAY_THREE',
  },
  {
    id: 'visual-polish-readme-preview',
    title: 'Polish the README preview',
    prompt: 'Prepare the visual reference for the README preview.',
    reply: 'VISUAL_REPLAY_TWO',
  },
  {
    id: 'visual-refine-native-window-chrome',
    title: 'Refine native window chrome',
    prompt: 'Prepare the visual reference for the native window chrome.',
    reply: 'VISUAL_REPLAY_ONE',
  },
] as const

const EXPECTED_INITIAL_SIZE = { width: 1280, height: 840 } as const
const MINIMUM_WINDOW_SIZE = { width: 900, height: 640 } as const
const TERMINAL_EVIDENCE_SESSION: VisualSession = {
  id: 'visual-terminal-behavior-proof',
  title: 'Verify installed runtime behavior',
  prompt: TERMINAL_TRACER_PROMPT,
  reply: 'DONE',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function capture(window: BrowserWindow, framesDir: string, name: string): Promise<CapturedFrame> {
  const image = await captureStableFrame(window, 'UI', name)
  const png = image.toPNG()
  const file = `${name}.png`
  writeFileSync(join(framesDir, file), png)
  return {
    file,
    bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
  }
}

async function callHost(
  window: BrowserWindow,
  rpcId: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const request = {
    id: rpcId,
    url: `dsh://app/api/${method}`,
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  }
  const response = await window.webContents.executeJavaScript(
    `globalThis.dshDesktop.request(${JSON.stringify(request)})`,
  ) as unknown
  if (!isRecord(response) || response.status !== 200 || typeof response.body !== 'string') {
    throw new Error(`desktop UI evidence received an invalid ${method} transport response`)
  }
  const envelope = JSON.parse(response.body) as unknown
  if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || !isRecord(envelope.result)) {
    throw new Error(`desktop UI evidence received an invalid ${method} RPC envelope`)
  }
  if (envelope.result.ok !== true) {
    const message = isRecord(envelope.result.error) && typeof envelope.result.error.message === 'string'
      ? envelope.result.error.message
      : JSON.stringify(envelope.result)
    throw new Error(`desktop UI evidence ${method} failed: ${message}`)
  }
  return envelope.result.value
}

async function waitForSessionReplay(window: BrowserWindow, session: VisualSession): Promise<void> {
  const deadline = Date.now() + 60_000
  let attempt = 0
  for (;;) {
    attempt += 1
    const list = await callHost(window, `visual-list-${session.id}-${String(attempt)}`, 'session.list', {})
    const history = await callHost(
      window,
      `visual-history-${session.id}-${String(attempt)}`,
      'session.history',
      { sessionId: session.id },
    )
    const item = isRecord(list) && Array.isArray(list.items)
      ? list.items.find(candidate => isRecord(candidate) && candidate.sessionId === session.id)
      : undefined
    if (isRecord(item) && item.blank === false && item.running === false
      && JSON.stringify(history).includes(session.reply)) return
    if (Date.now() > deadline) {
      throw new Error(`desktop UI evidence timed out waiting for replay in ${session.id}`)
    }
    await new Promise(done => setTimeout(done, 50))
  }
}

async function createVisualReferenceState(window: BrowserWindow, pickedDirectory: string): Promise<string> {
  const created = await callHost(window, 'visual-workspace-create', 'workspace.create', { path: pickedDirectory })
  const workspace = isRecord(created) && isRecord(created.workspace) ? created.workspace : undefined
  if (workspace === undefined || typeof workspace.workspaceId !== 'string') {
    throw new Error('desktop UI evidence workspace.create returned no workspace')
  }
  for (const session of VISUAL_SESSIONS.toReversed()) {
    await callHost(window, `visual-create-${session.id}`, 'session.create', {
      workspaceId: workspace.workspaceId,
      sessionId: session.id,
    })
  }
  // Workspace attachment prepends sessions, so bottom-to-top creation preserves
  // the approved order. Prompting in the same order also binds replay scripts deterministically.
  for (const session of VISUAL_SESSIONS.toReversed()) {
    await callHost(window, `visual-prompt-${session.id}`, 'session.prompt', {
      sessionId: session.id,
      mode: 'queue',
      content: [{ type: 'text', text: session.prompt }],
      clientTimeZone: 'UTC',
    })
    await waitForSessionReplay(window, session)
    await callHost(window, `visual-rename-${session.id}`, 'session.rename', {
      sessionId: session.id,
      title: session.title,
    })
  }
  return workspace.workspaceId
}

async function resolvedVisualEvidence(
  window: BrowserWindow,
  initialWindowSize: { readonly width: number; readonly height: number },
  initialWorkArea: { readonly width: number; readonly height: number },
): Promise<{
  readonly deterministic: Record<string, unknown>
  readonly semantics: Record<string, unknown>
  readonly geometry: Record<string, unknown>
  readonly visualContract: Record<string, unknown>
}> {
  const titles = VISUAL_SESSIONS.map(session => session.title)
  const expanded = await window.webContents.executeJavaScript(`(() => {
    if (document.querySelector('[data-sidebar-collapsed="false"]') !== null) return true
    const reveal = document.querySelector('[data-desktop-sidebar-reveal]')
    if (!(reveal instanceof HTMLButtonElement)) return false
    reveal.click()
    return true
  })()`) as unknown
  if (expanded !== true) throw new Error('desktop UI evidence could not expand the sidebar')
  await waitFor(window, `document.querySelector('[data-sidebar-collapsed="false"]') !== null`, 'expanded sidebar')
  await waitFor(window, `(() => {
    const expected = ${JSON.stringify(titles)}
    const visible = [...document.querySelectorAll('[role="treeitem"]')].map(row => row.textContent ?? '')
    return expected.every(title => visible.some(text => text.includes(title)))
  })()`, 'three renamed visual-reference sessions')
  await waitFor(window, `document.documentElement.lang.startsWith('en')
    && document.body.dataset.dshAppearance === 'light'`, 'fixed locale and appearance')
  window.focus()
  const focusDeadline = Date.now() + 5_000
  while (!window.isFocused() && Date.now() <= focusDeadline) {
    await new Promise(done => setTimeout(done, 50))
  }
  const renderer = await window.webContents.executeJavaScript(`(() => {
    const titles = ${JSON.stringify(titles)}
    const round = value => Math.round(value * 100) / 100
    const rect = element => {
      if (!(element instanceof Element)) return null
      const box = element.getBoundingClientRect()
      return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }
    }
    const treeRows = [...document.querySelectorAll('[role="treeitem"]')]
    const titledRows = titles.map(title => treeRows.find(row =>
      [...row.querySelectorAll('span')].some(span => span.textContent?.trim() === title)))
    const orderedTitles = treeRows.flatMap(row => {
      const title = titles.find(candidate => [...row.querySelectorAll('span')]
        .some(span => span.textContent?.trim() === candidate))
      return title === undefined ? [] : [title]
    })
    const relativeTimes = titledRows.map((row, index) => {
      const title = [...(row?.querySelectorAll('span') ?? [])]
        .find(span => span.textContent?.trim() === titles[index])
      const time = title?.nextElementSibling
      return time instanceof HTMLElement && (time.textContent?.trim().length ?? 0) > 0 ? time : undefined
    })
    const brand = document.querySelector('[data-desktop-sidebar-brand-row]')
    const panelControl = document.querySelector('[data-desktop-sidebar-toggle]')
    const controlRow = document.querySelector('[data-desktop-sidebar-control-row]')
    const sidebar = document.querySelector('[data-slot="sidebar"] > div')
    const style = document.createElement('style')
    style.id = 'dsh-visual-acceptance-settlement'
    style.textContent = '*,:before,:after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}'
    document.head.append(style)
    for (const time of relativeTimes) {
      if (time === undefined) continue
      time.dataset.visualRelativeTime = 'excluded'
      time.style.visibility = 'hidden'
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    for (const animation of document.getAnimations()) animation.finish()
    return {
      locale: document.documentElement.lang,
      appearance: document.body.dataset.dshAppearance,
      sessionOrder: orderedTitles,
      relativeTimeCount: relativeTimes.filter(Boolean).length,
      animationsRunning: document.getAnimations().filter(animation => animation.playState === 'running').length,
      brand: {
        present: brand !== null,
        accessibleName: brand?.getAttribute('aria-label') ?? null,
        text: brand?.textContent?.trim() ?? '',
        graphic: brand !== null && brand.querySelector('svg, img') !== null,
      },
      panelControl: {
        present: panelControl !== null,
        accessibleName: panelControl?.getAttribute('aria-label') ?? null,
        text: panelControl?.textContent?.trim() ?? '',
        graphic: panelControl !== null && panelControl.querySelector('svg, img') !== null,
      },
      chromeRows: { separate: controlRow !== null && brand !== null && !controlRow.contains(brand) },
      geometry: {
        viewport: { width: innerWidth, height: innerHeight },
        sidebar: rect(sidebar),
        chrome: rect(controlRow),
        brand: rect(brand),
        panelControl: rect(panelControl),
      },
    }
  })()`) as unknown
  if (!isRecord(renderer) || renderer.locale !== 'en' || renderer.appearance !== 'light'
    || renderer.relativeTimeCount !== VISUAL_SESSIONS.length || renderer.animationsRunning !== 0
    || !isRecord(renderer.brand) || !isRecord(renderer.panelControl)
    || !isRecord(renderer.chromeRows) || !isRecord(renderer.geometry)) {
    throw new Error(`desktop UI evidence resolved invalid reference facts: ${JSON.stringify(renderer)}`)
  }
  const currentWindowBounds = window.getBounds()
  const resolvedRequestedSize = {
    width: Math.min(EXPECTED_INITIAL_SIZE.width, initialWorkArea.width),
    height: Math.min(EXPECTED_INITIAL_SIZE.height, initialWorkArea.height),
  }
  const constrainedByWorkArea = initialWindowSize.width === resolvedRequestedSize.width
    && initialWindowSize.height === resolvedRequestedSize.height
    && (initialWindowSize.width !== EXPECTED_INITIAL_SIZE.width
      || initialWindowSize.height !== EXPECTED_INITIAL_SIZE.height)
  const initialSizeMatches = initialWindowSize.width === EXPECTED_INITIAL_SIZE.width
    && initialWindowSize.height === EXPECTED_INITIAL_SIZE.height
  const brandMatches = renderer.brand.present === true && renderer.brand.graphic === true
    && renderer.brand.accessibleName === 'deepseek HARNESS'
    && renderer.brand.text === ''
  const panelMatches = renderer.panelControl.present === true
    && renderer.panelControl.graphic === true
    && renderer.panelControl.text === ''
  const mismatches = [
    ...(brandMatches ? [] : ['brand.identity']),
    ...(panelMatches ? [] : ['sidebar.panel-control']),
    ...(renderer.chromeRows.separate === true ? [] : ['sidebar.chrome-rows']),
    ...(initialSizeMatches || constrainedByWorkArea ? [] : ['window.initial-size']),
  ]
  return {
    deterministic: {
      locale: renderer.locale,
      appearance: renderer.appearance,
      zoomFactor: window.webContents.getZoomFactor(),
      sessionIds: VISUAL_SESSIONS.map(session => session.id),
      sessionOrder: renderer.sessionOrder,
      sessions: VISUAL_SESSIONS.map(session => ({
        sessionId: session.id,
        title: session.title,
        blank: false,
        replayMarker: session.reply,
      })),
      replayComplete: true,
      animationsRunning: renderer.animationsRunning,
      compositorFrames: 2,
      relativeTime: { asserted: true, excludedFromImages: true },
    },
    semantics: {
      brand: renderer.brand,
      panelControl: renderer.panelControl,
      chromeRows: renderer.chromeRows,
    },
    geometry: {
      initialWindow: initialWindowSize,
      initialWorkArea,
      window: { width: currentWindowBounds.width, height: currentWindowBounds.height },
      ...renderer.geometry,
    },
    visualContract: {
      expectedInitialSize: EXPECTED_INITIAL_SIZE,
      windowSizing: {
        actual: initialWindowSize,
        constrainedByWorkArea,
        reason: constrainedByWorkArea ? 'display-work-area' : null,
      },
      mismatches,
    },
  }
}

async function waitForWindowState(
  window: BrowserWindow,
  ready: () => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`desktop UI evidence timed out waiting for ${label}: ${JSON.stringify(window.getBounds())}`)
    }
    await new Promise(done => setTimeout(done, 50))
  }
}

async function readResponsiveLayoutState(window: BrowserWindow): Promise<ResponsiveLayoutState> {
  const renderer = await window.webContents.executeJavaScript(`(() => {
    const round = value => Math.round(value)
    const frame = document.querySelector('[data-sidebar-collapsed]')
    const collapsed = frame?.getAttribute('data-sidebar-collapsed') === 'true'
    const sidebarSlot = document.querySelector('[data-slot="sidebar"]')
    const control = document.querySelector(collapsed
      ? '[data-desktop-sidebar-reveal]'
      : '[data-desktop-sidebar-toggle]')
    const header = document.querySelector('[data-slot="conversation.session.header"] > header')
    const tabs = header?.querySelector('[role="tablist"]') ?? null
    if (!(frame instanceof HTMLElement) || !(sidebarSlot instanceof HTMLElement)
      || !(control instanceof HTMLElement) || !(header instanceof HTMLElement)) return null
    let sidebarColumn = sidebarSlot
    while (sidebarColumn.parentElement !== null && sidebarColumn.parentElement !== frame) {
      sidebarColumn = sidebarColumn.parentElement
    }
    if (sidebarColumn.parentElement !== frame) return null
    const controlStyle = getComputedStyle(control)
    const controlRect = control.getBoundingClientRect()
    if (controlStyle.display === 'none' || controlStyle.visibility === 'hidden'
      || controlRect.width === 0 || controlRect.height === 0) return null
    return {
      fullscreen: document.body.dataset.dshFullscreen === 'true',
      collapsed,
      sidebarWidth: round(sidebarColumn.getBoundingClientRect().width),
      declaredSidebarWidth: round(Number.parseFloat(
        getComputedStyle(frame).getPropertyValue('--dsh-sidebar-width'),
      )),
      control: collapsed ? 'reveal' : 'collapse',
      controlLeft: round(controlRect.left),
      headerPaddingLeft: round(Number.parseFloat(getComputedStyle(header).paddingLeft)),
      tabsLeft: tabs instanceof HTMLElement ? round(tabs.getBoundingClientRect().left) : null,
      sidebarAncestors: (() => {
        const rows = []
        let element = sidebarSlot
        while (element instanceof HTMLElement) {
          const style = getComputedStyle(element)
          rows.push({
            tag: element.tagName,
            slot: element.getAttribute('data-slot'),
            className: element.className,
            rectWidth: round(element.getBoundingClientRect().width),
            width: style.width,
            minWidth: style.minWidth,
            overflow: style.overflow,
            borderRightWidth: style.borderRightWidth,
          })
          if (element === frame) break
          element = element.parentElement
        }
        return rows
      })(),
    }
  })()`) as unknown
  if (!isRecord(renderer) || typeof renderer.fullscreen !== 'boolean'
    || typeof renderer.collapsed !== 'boolean' || typeof renderer.sidebarWidth !== 'number'
    || typeof renderer.declaredSidebarWidth !== 'number'
    || (renderer.control !== 'collapse' && renderer.control !== 'reveal')
    || typeof renderer.controlLeft !== 'number' || typeof renderer.headerPaddingLeft !== 'number'
    || (renderer.tabsLeft !== null && typeof renderer.tabsLeft !== 'number')) {
    throw new Error(`desktop UI evidence resolved invalid responsive state: ${JSON.stringify(renderer)}`)
  }
  if (renderer.sidebarWidth !== renderer.declaredSidebarWidth) {
    throw new Error(`desktop UI evidence sidebar track does not match its resolved geometry: ${JSON.stringify(renderer.sidebarAncestors)}`)
  }
  const bounds = window.getBounds()
  return {
    window: { width: bounds.width, height: bounds.height },
    fullscreen: renderer.fullscreen,
    collapsed: renderer.collapsed,
    sidebarWidth: renderer.sidebarWidth,
    declaredSidebarWidth: renderer.declaredSidebarWidth,
    control: renderer.control,
    controlLeft: renderer.controlLeft,
    headerPaddingLeft: renderer.headerPaddingLeft,
    tabsLeft: renderer.tabsLeft,
  }
}

async function settleRendererLayout(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })`)
}

async function toggleSidebar(window: BrowserWindow, collapsed: boolean, label: string): Promise<void> {
  const selector = collapsed
    ? '[data-desktop-sidebar-reveal]'
    : '[data-desktop-sidebar-toggle]'
  const toggled = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)})
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  })()`) as unknown
  if (toggled !== true) throw new Error('desktop UI evidence found no reachable sidebar control')
  await waitFor(
    window,
    `document.querySelector('[data-sidebar-collapsed="${String(!collapsed)}"]') !== null`,
    label,
  )
}

async function exerciseResponsiveLayout(
  window: BrowserWindow,
  framesDir: string,
  frames: CapturedFrame[],
): Promise<ResponsiveEvidence> {
  const expanded = await readResponsiveLayoutState(window)

  await toggleSidebar(window, false, 'wide manually collapsed sidebar')
  const collapsed = await readResponsiveLayoutState(window)
  frames.push(await capture(window, framesDir, '09-sidebar-collapsed'))

  window.setSize(900, 640)
  await waitForWindowState(window, () => {
    const bounds = window.getBounds()
    return bounds.width === 900 && bounds.height === 640
  }, 'narrow window bounds')
  await settleRendererLayout(window)
  await waitFor(window, `document.querySelector('[data-sidebar-collapsed="true"]') !== null`, 'narrow auto-collapse')
  const narrowCollapsed = await readResponsiveLayoutState(window)

  await toggleSidebar(window, true, 'narrow manually reopened sidebar')
  const narrowReopened = await readResponsiveLayoutState(window)
  frames.push(await capture(window, framesDir, '10-sidebar-narrow-reopened'))

  window.setSize(EXPECTED_INITIAL_SIZE.width, EXPECTED_INITIAL_SIZE.height)
  await waitForWindowState(window, () => {
    const bounds = window.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workArea
    return isRequestedWindowSizeSettled(
      bounds, EXPECTED_INITIAL_SIZE, MINIMUM_WINDOW_SIZE.height, workArea,
    )
  }, 'restored window bounds')
  await settleRendererLayout(window)
  await waitFor(window, `document.querySelector('[data-sidebar-collapsed="true"]') !== null`, 'restored wide layout')
  await toggleSidebar(window, true, 'resized manually reopened sidebar')
  const resizedExpanded = await readResponsiveLayoutState(window)

  await toggleSidebar(window, false, 'pre-fullscreen manually collapsed sidebar')
  window.setFullScreen(true)
  await waitForWindowState(window, () => window.isFullScreen(), 'native fullscreen')
  await waitFor(window, `document.body.dataset.dshFullscreen === 'true'`, 'renderer fullscreen projection')
  const fullscreenCollapsed = await readResponsiveLayoutState(window)
  frames.push(await capture(window, framesDir, '11-sidebar-fullscreen'))

  window.setFullScreen(false)
  await waitForWindowState(window, () => !window.isFullScreen(), 'leaving native fullscreen')
  await waitFor(window, `document.body.dataset.dshFullscreen === 'false'`, 'windowed renderer projection')
  window.setSize(EXPECTED_INITIAL_SIZE.width, EXPECTED_INITIAL_SIZE.height)
  await waitForWindowState(window, () => {
    const bounds = window.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workArea
    return isRequestedWindowSizeSettled(
      bounds, EXPECTED_INITIAL_SIZE, MINIMUM_WINDOW_SIZE.height, workArea,
    )
  }, 'final window bounds')
  await settleRendererLayout(window)
  await toggleSidebar(window, true, 'final manually reopened sidebar')

  return { expanded, collapsed, narrowCollapsed, narrowReopened, resizedExpanded, fullscreenCollapsed }
}

async function captureTerminalBehaviorEvidence(
  window: BrowserWindow,
  workspaceId: string,
  framesDir: string,
  frames: CapturedFrame[],
): Promise<void> {
  const session = TERMINAL_EVIDENCE_SESSION
  await callHost(window, `visual-create-${session.id}`, 'session.create', {
    workspaceId,
    sessionId: session.id,
  })
  await callHost(window, `visual-prompt-${session.id}`, 'session.prompt', {
    sessionId: session.id,
    mode: 'queue',
    content: [{ type: 'text', text: session.prompt }],
    clientTimeZone: 'UTC',
  })
  await callHost(window, `visual-rename-${session.id}`, 'session.rename', {
    sessionId: session.id,
    title: session.title,
  })
  await waitFor(window, `(() => {
    const title = ${JSON.stringify(session.title)}
    return [...document.querySelectorAll('[role="treeitem"]')].some(row =>
      [...row.querySelectorAll('span')].some(span => span.textContent?.trim() === title))
  })()`, 'terminal evidence session')
  const opened = await window.webContents.executeJavaScript(`(() => {
    const title = ${JSON.stringify(session.title)}
    const row = [...document.querySelectorAll('[role="treeitem"]')].find(candidate =>
      [...candidate.querySelectorAll('span')].some(span => span.textContent?.trim() === title))
    if (!(row instanceof HTMLElement)) return false
    row.click()
    return true
  })()`) as unknown
  if (opened !== true) throw new Error('desktop UI evidence could not open the terminal proof session')
  await waitFor(window, `document.querySelector('[data-streaming="true"]') !== null
    || document.querySelector('[data-state="running"]') !== null`, 'incremental conversation state')
  frames.push(await capture(window, framesDir, '05-conversation-streaming'))
  await waitFor(window, `(() => {
    const tool = document.querySelector('[data-sample="bash"]')
    return tool?.getAttribute('data-state') === 'ok' && document.body.innerText.includes('DONE')
  })()`, 'streaming conversation and tool completion', 60_000)
  frames.push(await capture(window, framesDir, '06-conversation-complete'))

  await callHost(window, `visual-exhaust-${session.id}`, 'session.prompt', {
    sessionId: session.id,
    mode: 'queue',
    content: [{ type: 'text', text: 'Trigger the deterministic replay exhaustion error.' }],
    clientTimeZone: 'UTC',
  })
  await waitFor(window, `[...document.querySelectorAll('[role="status"]')]
    .some(row => row.querySelector('code') !== null)`, 'terminal conversation error', 60_000)
  frames.push(await capture(window, framesDir, '07-conversation-error'))
}

/**
 * Exercise the real Client journey and write reusable PNG, semantic, and geometry evidence.
 * The isolated journey adopts `pickedDirectory`, creates and replays three fixed
 * sessions through Host APIs, and renames them through the supported RPC behavior.
 */
export async function captureOfficialUiEvidence(
  window: BrowserWindow,
  framesDir: string,
  pickedDirectory: string,
): Promise<void> {
  mkdirSync(framesDir, { recursive: true })
  const frames: CapturedFrame[] = []
  const initialBounds = window.getBounds()
  const initialWindowSize = { width: initialBounds.width, height: initialBounds.height }
  const displayWorkArea = screen.getDisplayMatching(initialBounds).workArea
  const initialWorkArea = { width: displayWorkArea.width, height: displayWorkArea.height }
  await waitFor(window, `(() => {
    const graph = globalThis.__DSH_BOOT__
    return typeof graph === 'object' && graph !== null && Array.isArray(graph.entries)
  })()`, 'Client boot manifest')
  const boot = await window.webContents.executeJavaScript(`(() => ({
    ids: globalThis.__DSH_BOOT__.entries.map(row => row.id),
    body: document.body.innerText.slice(0, 500),
  }))()`) as { ids: string[]; body: string }
  const missing = REQUIRED_CLIENT_MODULES.filter(id => !boot.ids.includes(id))
  console.log(`DESKTOP_UI_BOOT ${JSON.stringify({ ids: boot.ids, missing, body: boot.body })}`)
  if (missing.length > 0) throw new Error(`desktop UI boot graph is missing ${missing.join(', ')}`)
  await waitFor(window, `document.querySelector('[class*="frame"]') !== null
    && document.querySelector('textarea') !== null
    && document.querySelector('[data-desktop-window-chrome]') !== null`, 'official Client surface')
  frames.push(await capture(window, framesDir, '01-workspace-picker'))

  const requested = await window.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('[data-composer-card]')
    if (!(card instanceof HTMLElement)) return false
    card.click()
    return true
  })()`) as unknown
  if (requested !== true) throw new Error('desktop UI evidence found no workspace picker trigger')
  await waitFor(window, `(() => {
    const input = document.querySelector('textarea')
    return input instanceof HTMLTextAreaElement && !input.disabled && !input.readOnly
  })()`, 'native workspace adoption')
  const expectedWorkspaceLabel = basename(pickedDirectory)
  const encodedWorkspaceLabel = JSON.stringify(expectedWorkspaceLabel)
  await waitFor(window, `[...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .some(button => button.textContent?.trim() === ${encodedWorkspaceLabel})`, 'picked workspace label')
  frames.push(await capture(window, framesDir, '02-workspace-adopted'))

  const openedCommands = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-composer-card] button[aria-haspopup="listbox"]')
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false
    button.click()
    return true
  })()`) as unknown
  if (openedCommands !== true) throw new Error('desktop UI evidence found no Commands trigger')
  await waitFor(window, 'document.querySelector(\'[role="listbox"]\') !== null', 'input trigger suggestions')
  frames.push(await capture(window, framesDir, '03-input-triggers'))
  await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-composer-card] button[aria-haspopup="listbox"]')
    if (button instanceof HTMLButtonElement) button.click()
  })()`)
  await waitFor(window, 'document.querySelector(\'[role="listbox"]\') === null', 'input trigger dismissal')

  const workspaceId = await createVisualReferenceState(window, pickedDirectory)
  const visual = await resolvedVisualEvidence(window, initialWindowSize, initialWorkArea)
  frames.push(await capture(window, framesDir, '04-visual-reference'))
  await captureTerminalBehaviorEvidence(window, workspaceId, framesDir, frames)

  const openedSettings = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('button[aria-haspopup="dialog"]')
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  })()`) as unknown
  if (openedSettings !== true) throw new Error('desktop UI evidence found no Settings trigger')
  await waitFor(window, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog !== null && dialog.querySelector('.dsh-desktop-glass-row input[type="checkbox"]') !== null
  })()`, 'settings contributions')
  const toggled = await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.dsh-desktop-glass-row input[type="checkbox"]')
    if (!(input instanceof HTMLInputElement) || input.disabled) return false
    if (input.checked) input.click()
    return true
  })()`) as unknown
  if (toggled !== true) throw new Error('desktop UI evidence could not mutate the sidebar setting')
  await waitFor(window, `(() => {
    const input = document.querySelector('.dsh-desktop-glass-row input[type="checkbox"]')
    return input instanceof HTMLInputElement && !input.checked
  })()`, 'durable setting projection')
  frames.push(await capture(window, framesDir, '08-settings'))

  const rendererEvidence = await window.webContents.executeJavaScript(`(() => ({
    graph: globalThis.__DSH_BOOT__.entries.map(row => row.id),
    tool: document.querySelector('[data-sample="bash"]')?.getAttribute('data-state'),
    answer: document.body.innerText.includes('DONE'),
    error: [...document.querySelectorAll('[role="status"]')].some(row => row.querySelector('code') !== null),
    settings: document.querySelector('.dsh-desktop-glass-row input[type="checkbox"]')?.checked,
    desktopChrome: document.querySelector('[data-desktop-window-chrome]') !== null,
  }))()`) as Record<string, unknown>
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await waitFor(window, `document.querySelector('[role="dialog"]') === null`, 'settings dismissal')
  const responsive = await exerciseResponsiveLayout(window, framesDir, frames)
  const evidence = {
    ...rendererEvidence,
    workspace: true,
    streaming: true,
    workspacePath: pickedDirectory,
    workspaceLabel: expectedWorkspaceLabel,
    ...visual,
    responsive,
    frames,
  }
  writeFileSync(join(framesDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`DESKTOP_UI_EVIDENCE ${JSON.stringify(evidence)}`)
}
