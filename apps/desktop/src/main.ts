import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, shell } from 'electron'
import { healProfilesModuleFallback } from '@deepseek-ai/dsh-app-boot'
import { bootstrapDesktopProfile } from '@dsh-desktop/bundle/profile-bootstrap'
import {
  parseDesktopBridgeRequest,
  parseDesktopParentMessage,
  type DesktopChildMessage,
} from '@dsh-desktop/connection'
import { desktopWindowWebPreferences } from '@dsh-desktop/connection/preload'
import { DshSupervisor, type SupervisorOptions, type DesktopNativeActionHandler } from './supervisor.js'
import { isTrustedRendererUrl } from './renderer-policy.js'
import { createDesktopUiProtocolHandler, DESKTOP_UI_URL } from './ui-protocol.js'
import { captureOfficialUiEvidence } from './ui-evidence.js'
import { captureStableFrame } from './frame-capture.js'
import {
  parseTracerInvocation,
  prepareTracerProfile,
  type TracerInvocation,
} from './tracer.js'
import {
  desktopWindowOptions,
  installNativeThemeHost,
  parseRendererSurfaceState,
  waitForWindowMove,
  type RendererSurfaceState,
  type RendererThemePreference,
} from './native-window.js'

const shellRoot = resolve(import.meta.dirname, '..')
const rendererPath = join(shellRoot, 'renderer.html')
let supervisor: DshSupervisor | undefined
let shutdownComplete = false
let shutdown: Promise<void> | undefined

app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
protocol.registerSchemesAsPrivileged([{
  scheme: 'dsh',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    codeCache: true,
  },
}])

function absoluteDirectory(label: string, value: string): string {
  if (!isAbsolute(value) || !existsSync(value)) throw new Error(`${label} must be an existing absolute path`)
  return value
}

function runtimeRoot(): string {
  const configured = process.env.DSH_DESKTOP_RUNTIME_ROOT
  if (configured !== undefined) return absoluteDirectory('DSH_DESKTOP_RUNTIME_ROOT', configured)
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'runtime')
    : resolve(shellRoot, '../..', '.artifacts', 'runtime')
  return absoluteDirectory('desktop runtime root', candidate)
}

function harnessHome(): string {
  const configured = process.env.DSH_HOME
  const home = configured === undefined ? app.getPath('userData') : configured
  if (!isAbsolute(home)) throw new Error('DSH_HOME must be an absolute path')
  mkdirSync(home, { recursive: true })
  return home
}

function resolveComponentVersion(root: string, packageName: string): string | undefined {
  try {
    const runtimeRequire = createRequire(join(root, 'package.json'))
    const manifest = JSON.parse(readFileSync(runtimeRequire.resolve(`${packageName}/package.json`), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

function bridgeStream(message: DesktopChildMessage): Record<string, unknown> | undefined {
  if (message.type === 'stream-open') return { type: 'open', id: message.id }
  if (message.type === 'stream-message') return { type: 'message', id: message.id, message: message.message }
  if (message.type === 'stream-error') return { type: 'error', id: message.id, message: message.message }
  if (message.type === 'stream-end') return { type: 'end', id: message.id }
  return undefined
}

function belongsToWindow(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  window: BrowserWindow,
): boolean {
  const senderFrame = event.senderFrame
  return !window.isDestroyed()
    && event.sender === window.webContents
    && senderFrame !== null
    && senderFrame.parent === null
    && isTrustedRendererUrl(senderFrame.url, rendererPath)
}

function processEvidenceObserver(): SupervisorOptions['onProcessSnapshot'] {
  if (process.env.DSH_DESKTOP_PROCESS_EVIDENCE !== '1') return undefined
  const reported = new Set<string>()
  return (snapshot) => {
    for (const processIdentity of [snapshot.root, ...snapshot.owned]) {
      if (processIdentity === undefined) continue
      const key = `${String(processIdentity.pid)}\0${processIdentity.started}`
      if (reported.has(key)) continue
      reported.add(key)
      console.log(`DESKTOP_PROCESS_IDENTITY ${JSON.stringify({
        pid: processIdentity.pid,
        started: processIdentity.started,
      })}`)
    }
  }
}

function runtimeEvidenceExecArgv(): readonly string[] | undefined {
  if (process.env.DSH_DESKTOP_PROCESS_EVIDENCE !== '1') return undefined
  const guard = process.env.DSH_DESKTOP_NETWORK_GUARD
  if (guard === undefined) return undefined
  if (!isAbsolute(guard) || !statSync(guard, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('DSH_DESKTOP_NETWORK_GUARD must name an absolute file')
  }
  return ['--require', guard]
}

function installCarrier(runtime: DshSupervisor, window: BrowserWindow): () => void {
  ipcMain.handle('dsh:request', async (event, value: unknown) => {
    if (!belongsToWindow(event, window)) throw new Error('desktop request came from an untrusted frame')
    const request = parseDesktopBridgeRequest(value)
    if (request === undefined) throw new Error('invalid desktop request')
    return await runtime.request({ type: 'request', ...request })
  })
  const cancelRequest = (event: Electron.IpcMainEvent, id: unknown): void => {
    if (!belongsToWindow(event, window)) return
    const parsed = parseDesktopParentMessage({ type: 'cancel-request', id })
    if (parsed?.type === 'cancel-request') runtime.cancelRequest(parsed.id)
  }
  const subscribe = (event: Electron.IpcMainEvent, id: unknown, stream: unknown): void => {
    if (!belongsToWindow(event, window)) return
    const parsed = parseDesktopParentMessage({ type: 'subscribe', id, stream })
    if (parsed?.type === 'subscribe') runtime.subscribe(parsed.id, parsed.stream)
  }
  const cancelSubscription = (event: Electron.IpcMainEvent, id: unknown): void => {
    if (!belongsToWindow(event, window)) return
    const parsed = parseDesktopParentMessage({ type: 'cancel-subscription', id })
    if (parsed?.type === 'cancel-subscription') runtime.cancelSubscription(parsed.id)
  }
  const ackStream = (event: Electron.IpcMainEvent, id: unknown): void => {
    if (!belongsToWindow(event, window)) return
    const parsed = parseDesktopParentMessage({ type: 'stream-ack', id })
    if (parsed?.type === 'stream-ack') runtime.ackStream(parsed.id)
  }
  ipcMain.on('dsh:cancel-request', cancelRequest)
  ipcMain.on('dsh:subscribe', subscribe)
  ipcMain.on('dsh:cancel-subscription', cancelSubscription)
  ipcMain.on('dsh:stream-ack', ackStream)
  const stopStream = runtime.onStream((message) => {
    const event = bridgeStream(message)
    if (event !== undefined && !window.isDestroyed()) window.webContents.send('dsh:stream', event)
  })
  return () => {
    stopStream()
    ipcMain.removeHandler('dsh:request')
    ipcMain.off('dsh:cancel-request', cancelRequest)
    ipcMain.off('dsh:subscribe', subscribe)
    ipcMain.off('dsh:cancel-subscription', cancelSubscription)
    ipcMain.off('dsh:stream-ack', ackStream)
  }
}

function assertNoTcpListener(pid: number): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  let output: string
  try {
    output = execFileSync('lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
  } catch (error) {
    const status = (error as { status?: unknown }).status
    if (status === 1) output = ''
    else throw error
  }
  if (output.trim() !== '') throw new Error(`desktop DSH child opened a TCP listener:\n${output}`)
  console.log('TRACER_OK no-loopback-listener')
}

async function assertTracerLayout(window: BrowserWindow): Promise<void> {
  const matches = await window.webContents.executeJavaScript(`(() => {
    const main = document.querySelector('main')
    const title = document.querySelector('h1')
    const message = document.querySelector('#status')
    if (!(main instanceof HTMLElement) || !(title instanceof HTMLElement)
      || !(message instanceof HTMLElement)) return false
    const bounds = main.getBoundingClientRect()
    const mainStyle = getComputedStyle(main)
    const titleStyle = getComputedStyle(title)
    const messageStyle = getComputedStyle(message)
    const bodyStyle = getComputedStyle(document.body)
    return title.textContent === 'DeepSeek Harness'
      && Math.abs(bounds.left + bounds.width / 2 - innerWidth / 2) <= 1
      && Math.abs(bounds.top + bounds.height / 2 - innerHeight / 2) <= 1
      && bodyStyle.fontFamily.includes('-apple-system')
      && mainStyle.textAlign === 'center'
      && mainStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
      && Math.abs(parseFloat(titleStyle.fontSize) - 21.6) <= 0.1
      && titleStyle.fontWeight === '600'
      && titleStyle.marginBottom === '16px'
      && messageStyle.fontSize === '16px'
      && messageStyle.lineHeight === '24px'
  })()`) as unknown
  if (matches !== true) throw new Error('desktop tracer did not use the centered system status layout')
  console.log('TRACER_LAYOUT centered-system-status')
}

async function settleRendererPaint(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
}

async function captureTracer(window: BrowserWindow, tracer: TracerInvocation): Promise<void> {
  let previous = ''
  let frame = 0
  const deadline = Date.now() + 120_000
  for (;;) {
    const state = await window.webContents.executeJavaScript('document.body.dataset.state') as unknown
    if (typeof state === 'string' && state !== previous) {
      previous = state
      console.log(`TRACER_STATE ${state}`)
      if (tracer.framesDir !== undefined) {
        mkdirSync(tracer.framesDir, { recursive: true })
        const image = state === 'complete'
          ? await captureStableFrame(window, 'terminal', state)
          : await window.webContents.capturePage()
        if (state === 'complete') {
          const bitmap = image.toBitmap()
          let visiblePixels = 0
          for (let offset = 0; offset < bitmap.length; offset += 4) {
            const blue = bitmap[offset] ?? 0
            const green = bitmap[offset + 1] ?? 0
            const red = bitmap[offset + 2] ?? 0
            if (green > 160 && green > red + 30 && green > blue + 20) visiblePixels += 1
          }
          if (visiblePixels < 100) throw new Error('desktop renderer completed without a visible terminal result')
          console.log(`TRACER_VISIBLE terminal-result ${String(visiblePixels)} bright pixels`)
        }
        frame += 1
        writeFileSync(join(tracer.framesDir, `${String(frame).padStart(2, '0')}-${state}.png`), image.toPNG())
      }
    }
    if (state === 'complete') return
    if (state === 'failed') {
      const message = await window.webContents.executeJavaScript('document.querySelector("#result")?.textContent') as unknown
      throw new Error(`desktop renderer tracer failed: ${String(message)}`)
    }
    if (Date.now() > deadline) throw new Error('desktop renderer tracer timed out')
    await new Promise(done => setTimeout(done, 50))
  }
}

type NativeEvidenceWindowEvent = 'enter-full-screen' | 'leave-full-screen' | 'focus' | 'blur' | 'resize'

function waitForWindowEvent(window: BrowserWindow, event: NativeEvidenceWindowEvent): Promise<void> {
  const emitter = window as unknown as {
    once(name: NativeEvidenceWindowEvent, listener: () => void): void
    off(name: NativeEvidenceWindowEvent, listener: () => void): void
  }
  return new Promise((resolveEvent, rejectEvent) => {
    const remove = (): void => {
      emitter.off(event, onEvent)
    }
    const timeout = setTimeout(() => {
      remove()
      rejectEvent(new Error(`desktop native window timed out waiting for ${event}`))
    }, 15_000)
    const onEvent = (): void => {
      clearTimeout(timeout)
      resolveEvent()
    }
    emitter.once(event, onEvent)
  })
}

async function waitForThemeSource(preference: RendererThemePreference): Promise<void> {
  const deadline = Date.now() + 5_000
  while (nativeTheme.themeSource !== preference) {
    if (Date.now() > deadline) throw new Error(`desktop native theme did not reach ${preference}`)
    await new Promise(done => setTimeout(done, 10))
  }
}

async function rendererNativeState(window: BrowserWindow): Promise<RendererSurfaceState> {
  const value = await window.webContents.executeJavaScript('globalThis.dshNativeTheme?.getState()') as unknown
  const state = parseRendererSurfaceState(value)
  if (state === undefined) throw new Error('desktop renderer returned invalid native window evidence')
  return state
}

async function waitForRendererAppearance(window: BrowserWindow, appearance: 'light' | 'dark'): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const projected = await window.webContents.executeJavaScript(
      `document.body.dataset.dshAppearance === ${JSON.stringify(appearance)}`,
    ) as unknown
    if (projected === true) {
      await settleRendererPaint(window)
      return
    }
    if (Date.now() > deadline) throw new Error(`desktop renderer did not project ${appearance} appearance`)
    await new Promise(done => setTimeout(done, 10))
  }
}

async function captureNativeFrame(
  window: BrowserWindow,
  framesDir: string | undefined,
  name: string,
): Promise<void> {
  if (framesDir === undefined) return
  mkdirSync(framesDir, { recursive: true })
  const image = await captureStableFrame(window, 'native', name)
  writeFileSync(join(framesDir, `${name}.png`), image.toPNG())
}

interface RendererRegionEvidence {
  readonly dragRegion: string
  readonly controlRegion: string
  readonly dragPoint: { readonly x: number; readonly y: number }
  readonly controlPoint: { readonly x: number; readonly y: number }
}

function parseRendererPoint(input: unknown): { x: number; y: number } | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  return typeof record.x === 'number' && Number.isFinite(record.x)
    && typeof record.y === 'number' && Number.isFinite(record.y)
    ? { x: record.x, y: record.y }
    : undefined
}

async function rendererRegionEvidence(window: BrowserWindow): Promise<RendererRegionEvidence> {
  const value = await window.webContents.executeJavaScript(`(() => {
    const drag = document.querySelector('[data-window-drag-surface]')
    const control = document.querySelector('[data-native-control-surface]')
    if (!(drag instanceof HTMLElement) || !(control instanceof HTMLElement)) return null
    const point = element => {
      const bounds = element.getBoundingClientRect()
      return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) }
    }
    const dragBounds = drag.getBoundingClientRect()
    return {
      dragRegion: getComputedStyle(drag).getPropertyValue('-webkit-app-region'),
      controlRegion: getComputedStyle(control).getPropertyValue('-webkit-app-region'),
      dragPoint: { x: Math.round(dragBounds.left + dragBounds.width / 2), y: Math.round(dragBounds.top + 8) },
      controlPoint: point(control),
    }
  })()`) as unknown
  if (typeof value !== 'object' || value === null) throw new Error('desktop renderer exposed no native regions')
  const candidate = value as Record<string, unknown>
  const dragPoint = parseRendererPoint(candidate.dragPoint)
  const controlPoint = parseRendererPoint(candidate.controlPoint)
  if (candidate.dragRegion !== 'drag' || candidate.controlRegion !== 'no-drag'
    || dragPoint === undefined || controlPoint === undefined) {
    throw new Error(`desktop renderer native regions are invalid: ${JSON.stringify(value)}`)
  }
  return { dragRegion: candidate.dragRegion, controlRegion: candidate.controlRegion, dragPoint, controlPoint }
}

async function attemptRendererDrag(
  window: BrowserWindow,
  point: { readonly x: number; readonly y: number },
): Promise<boolean> {
  const before = window.getBounds()
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    x: point.x + 40,
    y: point.y + 40,
    movementX: 40,
    movementY: 40,
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: point.x + 40,
    y: point.y + 40,
    button: 'left',
    clickCount: 1,
  })
  await new Promise(done => setTimeout(done, 250))
  const after = window.getBounds()
  return before.x !== after.x || before.y !== after.y
}

async function acceptOsPointerDrag(
  window: BrowserWindow,
  stage: 'drag' | 'control',
  point: { readonly x: number; readonly y: number },
  shouldMove: boolean,
): Promise<boolean> {
  const before = window.getBounds()
  const content = window.getContentBounds()
  const screenPoint = { x: content.x + point.x, y: content.y + point.y }
  const movement = waitForWindowMove(window, shouldMove ? 15_000 : 3_000)
  console.log(`NATIVE_WINDOW_DRAG_READY ${JSON.stringify({ stage, point: screenPoint })}`)
  const didMove = await movement
  if (didMove) await new Promise(done => setTimeout(done, 300))
  const after = window.getBounds()
  const changed = before.x !== after.x || before.y !== after.y
  if (changed !== shouldMove) {
    throw new Error(
      `desktop OS drag stage ${stage} expected move=${String(shouldMove)}; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
  }
  console.log(`NATIVE_WINDOW_DRAG_STAGE ${JSON.stringify({ stage, point: screenPoint, before, after })}`)
  return changed
}

/** Exercise Electron-owned window state through the context-isolated renderer bridge. */
async function inspectNativeWindow(window: BrowserWindow, framesDir?: string): Promise<void> {
  const trafficLights = window.getWindowButtonPosition()
  if (trafficLights?.x !== 16 || trafficLights.y !== 14) {
    throw new Error(`desktop traffic lights are misplaced: ${JSON.stringify(trafficLights)}`)
  }
  if (!window.isResizable() || !window.isMovable() || !window.isFocusable()
    || !window.isClosable() || !window.isMinimizable() || !window.isFullScreenable()) {
    throw new Error('desktop native window disabled a required macOS window action')
  }

  for (const preference of ['dark', 'light', 'system'] as const) {
    await window.webContents.executeJavaScript(
      `globalThis.dshNativeTheme?.setPreference(${JSON.stringify(preference)})`,
    )
    await waitForThemeSource(preference)
    const state = await rendererNativeState(window)
    if (preference !== 'system' && state.appearance !== preference) {
      throw new Error(`desktop native theme mismatch for ${preference}: ${state.appearance}`)
    }
    await waitForRendererAppearance(window, state.appearance)
    await captureNativeFrame(window, framesDir, `native-${preference}`)
  }

  const initial = await rendererNativeState(window)
  const expectedTransparency = nativeTheme.prefersReducedTransparency ? 'opaque' : 'glass'
  if (initial.transparency !== expectedTransparency || initial.platform !== 'darwin') {
    throw new Error(`desktop native accessibility state mismatch: ${JSON.stringify(initial)}`)
  }

  const regions = await rendererRegionEvidence(window)
  const dragAttemptMoved = await attemptRendererDrag(window, regions.dragPoint)
  const controlAttemptMoved = await attemptRendererDrag(window, regions.controlPoint)
  if (controlAttemptMoved) throw new Error('desktop no-drag control moved the native window')
  let osDragMoved: boolean | undefined
  let osControlMoved: boolean | undefined
  if (process.env['DSH_DESKTOP_REQUIRE_OS_DRAG'] === '1') {
    const dragBounds = window.getBounds()
    osDragMoved = await acceptOsPointerDrag(window, 'drag', regions.dragPoint, true)
    window.setBounds(dragBounds)
    await new Promise(done => setTimeout(done, 250))
    osControlMoved = await acceptOsPointerDrag(window, 'control', regions.controlPoint, false)
  }

  const originalBounds = window.getBounds()
  const resizedEvent = waitForWindowEvent(window, 'resize')
  window.setSize(originalBounds.width + 40, originalBounds.height + 20)
  await resizedEvent
  const resizedBounds = window.getBounds()
  const resized = resizedBounds.width !== originalBounds.width || resizedBounds.height !== originalBounds.height
  if (!resized) throw new Error('desktop native window did not resize')
  window.setBounds(originalBounds)

  const focusTransitions = ['active']
  const blurred = waitForWindowEvent(window, 'blur')
  const other = new BrowserWindow({ width: 240, height: 160, show: true })
  try {
    other.focus()
    await blurred
    if ((await rendererNativeState(window)).focused) {
      throw new Error('desktop renderer did not observe native window blur')
    }
    focusTransitions.push('inactive')
    const focused = waitForWindowEvent(window, 'focus')
    window.focus()
    await focused
    if (!(await rendererNativeState(window)).focused) {
      throw new Error('desktop renderer did not observe native window focus')
    }
    focusTransitions.push('active')
  } finally {
    other.destroy()
  }

  const entered = waitForWindowEvent(window, 'enter-full-screen')
  window.setFullScreen(true)
  await entered
  const fullscreen = await rendererNativeState(window)
  if (!fullscreen.fullscreen || !window.isFullScreen()) {
    throw new Error('desktop renderer did not observe native fullscreen entry')
  }
  const left = waitForWindowEvent(window, 'leave-full-screen')
  window.setFullScreen(false)
  await left
  const restored = await rendererNativeState(window)
  if (restored.fullscreen || window.isFullScreen()) {
    throw new Error('desktop renderer did not observe native fullscreen exit')
  }

  console.log(`NATIVE_WINDOW_EVIDENCE ${JSON.stringify({
    trafficLights,
    resizable: window.isResizable(),
    movable: window.isMovable(),
    focusable: window.isFocusable(),
    closable: window.isClosable(),
    minimizable: window.isMinimizable(),
    fullscreenable: window.isFullScreenable(),
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    dragRegion: regions.dragRegion,
    controlRegion: regions.controlRegion,
    dragAttemptMoved,
    osDragMoved,
    osControlMoved,
    focusTransitions,
    resized,
    state: restored,
  })}`)
}

async function startRuntime(runtime: DshSupervisor, options: Parameters<DshSupervisor['start']>[0]): Promise<Awaited<ReturnType<DshSupervisor['start']>>> {
  try {
    return await runtime.start(options)
  } catch (firstError) {
    if (shutdown !== undefined) throw firstError
    console.error('[desktop-main] initial child generation failed; restarting once:', firstError)
    return await runtime.restart()
  }
}

/**
 * The real operating-system adapter: one window-attached directory chooser and
 * the default-application handoff. Renderer-facing code never sees these APIs.
 */
function shellNativeActionHandler(window: BrowserWindow): DesktopNativeActionHandler {
  return async (request, signal) => {
    if (signal.aborted) throw signal.reason
    if (request.action === 'pick-directory') {
      if (window.isDestroyed()) return { kind: 'path', path: null }
      const outcome = await dialog.showOpenDialog(window, {
        title: 'Select Workspace Directory',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (signal.aborted) throw signal.reason
      return { kind: 'path', path: outcome.canceled ? null : outcome.filePaths[0] ?? null }
    }
    const failure = await shell.openPath(request.path)
    if (signal.aborted) throw signal.reason
    if (failure !== '') throw new Error(`desktop shell could not open the path: ${failure}`)
    return { kind: 'opened' }
  }
}

/** Deterministic dialog/shell replacement used only by the native tracer journey. */
function tracerNativeActionHandler(pickedDirectory: string): DesktopNativeActionHandler {
  return async (request, signal) => {
    if (signal.aborted) throw signal.reason
    return request.action === 'pick-directory'
    ? { kind: 'path', path: pickedDirectory }
    : { kind: 'opened' }
  }
}

async function run(): Promise<void> {
  const root = runtimeRoot()
  if (process.env.DSH_DESKTOP_PROCESS_EVIDENCE === '1') {
    console.log(`DESKTOP_RUNTIME_ROOT ${JSON.stringify(root)}`)
  }
  const home = harnessHome()
  const tracer = parseTracerInvocation(process.argv)
  bootstrapDesktopProfile({
    home,
    resolveComponentVersion: packageName => resolveComponentVersion(root, packageName),
  })
  healProfilesModuleFallback(join(root, 'package.json'), home)
  if (tracer?.kind === 'terminal' || tracer?.kind === 'ui') {
    prepareTracerProfile(
      home,
      join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-replay'),
      tracer.replayFile,
      tracer.kind === 'ui'
        ? {
            acknowledgeWelcome: true,
            replayPaceMs: 80,
            replayChildFiles: tracer.replayChildFiles,
            locale: 'en',
            appearance: 'light',
          }
        : {},
    )
  }
  if (tracer?.kind === 'ui') nativeTheme.themeSource = 'light'

  const observeProcesses = processEvidenceObserver()
  const runtime = new DshSupervisor(undefined, observeProcesses === undefined
    ? {}
    : { onProcessSnapshot: observeProcesses })
  supervisor = runtime
  const evidenceExecArgv = runtimeEvidenceExecArgv()
  const options = {
    executable: process.execPath,
    cliEntry: join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    runtimeRoot: root,
    home,
    ...evidenceExecArgv === undefined ? {} : { execArgv: evidenceExecArgv },
  }
  const starting = startRuntime(runtime, options)
  if (process.argv.includes('--quit-during-startup')) {
    app.quit()
    await starting.catch(() => undefined)
    return
  }
  const ready = await starting
  console.log(`DESKTOP_CHILD_PID ${String(ready.pid)}`)
  if (tracer !== undefined) assertNoTcpListener(ready.pid)

  const window = new BrowserWindow({
    width: 900,
    height: 640,
    show: tracer === undefined,
    ...desktopWindowOptions(process.platform),
    webPreferences: desktopWindowWebPreferences(join(shellRoot, 'lib', 'preload.cjs')),
  })
  if (tracer?.kind === 'ui') window.webContents.setZoomFactor(1)
  protocol.handle('dsh', createDesktopUiProtocolHandler(runtime))
  const preventUnknownNavigation = (event: Electron.Event, url: string): void => {
    if (!isTrustedRendererUrl(url, rendererPath)) event.preventDefault()
  }
  window.webContents.on('will-navigate', preventUnknownNavigation)
  window.webContents.on('will-redirect', preventUnknownNavigation)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const disposeCarrier = installCarrier(runtime, window)
  const disposeNativeTheme = installNativeThemeHost({
    ipcMain,
    nativeTheme,
    window,
    platform: process.platform,
    eventIsTrusted: event => belongsToWindow(event as Electron.IpcMainEvent, window),
  })
  const disposeNativeActions = tracer?.kind === 'native' || tracer?.kind === 'ui'
    ? runtime.onNativeActions(tracerNativeActionHandler(tracer.pickedDirectory))
    : runtime.onNativeActions(shellNativeActionHandler(window))
  window.on('closed', () => {
    protocol.unhandle('dsh')
    disposeCarrier()
    disposeNativeTheme()
    disposeNativeActions()
  })
  if (tracer === undefined || tracer.kind === 'ui') {
    await window.loadURL(DESKTOP_UI_URL)
  } else {
    await window.loadFile(rendererPath, {
      query: tracer.kind === 'native'
        ? { tracer: 'native', pick: tracer.pickedDirectory, open: tracer.openedPath }
        : { tracer: '1' },
    })
  }
  if (tracer?.kind === 'ui') {
    window.show()
    await captureOfficialUiEvidence(window, tracer.framesDir, tracer.pickedDirectory)
    console.log('TRACER_OK official-client-ui')
    app.quit()
    return
  }
  if (tracer !== undefined) {
    window.show()
    await assertTracerLayout(window)
    await captureTracer(window, tracer)
    if (process.platform === 'darwin') await inspectNativeWindow(window, tracer.framesDir)
    console.log('TRACER_OK terminal-session')
    app.quit()
    return
  }

  void runtime.nextUnexpectedExit().then(async () => {
    try {
      await runtime.restart()
    } catch (error) {
      console.error('[desktop-main] child recovery failed:', error)
      shutdown ??= (async () => {
        await runtime.stop()
        shutdownComplete = true
        app.exit(1)
      })()
    }
  })
}

app.on('window-all-closed', () => { app.quit() })
app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  shutdown ??= (async () => {
    await supervisor?.stop()
    shutdownComplete = true
    app.quit()
  })().catch((error: unknown) => {
    console.error('[desktop-main] shutdown failed:', error)
    shutdownComplete = true
    app.exit(1)
  })
})

void app.whenReady().then(run).catch((error: unknown) => {
  console.error('[desktop-main] startup failed:', error)
  shutdown ??= (async () => {
    await supervisor?.stop()
    shutdownComplete = true
    app.exit(1)
  })().catch((stopError: unknown) => {
    console.error('[desktop-main] startup-failure shutdown failed:', stopError)
    shutdownComplete = true
    app.exit(1)
  })
})
