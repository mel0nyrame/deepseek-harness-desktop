/** Keyless evidence journey through the real composed desktop Client. */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { captureStableFrame } from './frame-capture.js'
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
  const brandMatches = renderer.brand.present === true && renderer.brand.graphic === true
    && typeof renderer.brand.text === 'string'
    && renderer.brand.text.toLowerCase().includes('deepseek')
    && renderer.brand.text.includes('HARNESS')
  const panelMatches = renderer.panelControl.present === true
    && renderer.panelControl.graphic === true
    && renderer.panelControl.text === ''
  const mismatches = [
    ...(brandMatches ? [] : ['brand.identity']),
    ...(panelMatches ? [] : ['sidebar.panel-control']),
    ...(renderer.chromeRows.separate === true ? [] : ['sidebar.chrome-rows']),
    ...(initialWindowSize.width === EXPECTED_INITIAL_SIZE.width
      && initialWindowSize.height === EXPECTED_INITIAL_SIZE.height
      ? []
      : ['window.initial-size']),
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
      window: { width: currentWindowBounds.width, height: currentWindowBounds.height },
      ...renderer.geometry,
    },
    visualContract: { expectedInitialSize: EXPECTED_INITIAL_SIZE, mismatches },
  }
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
  const visual = await resolvedVisualEvidence(window, initialWindowSize)
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
  const evidence = {
    ...rendererEvidence,
    workspace: true,
    streaming: true,
    workspacePath: pickedDirectory,
    workspaceLabel: expectedWorkspaceLabel,
    ...visual,
    frames,
  }
  writeFileSync(join(framesDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`DESKTOP_UI_EVIDENCE ${JSON.stringify(evidence)}`)
}
