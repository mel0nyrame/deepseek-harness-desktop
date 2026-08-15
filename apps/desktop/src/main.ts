/** Electron desktop entry: development shell and packaged application. */

import { fork } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app, BrowserWindow, ipcMain, nativeTheme, net, protocol,
  type IpcMainEvent, type IpcMainInvokeEvent,
} from 'electron'
import { DshSupervisor } from './supervisor.ts'
import {
  PACKAGED_CHILD_EXEC_ARGV,
  packagedChildEnv,
  packagedRuntimeLayout,
  parseSmokeInvocation,
} from './packaged-runtime.ts'
import { prepareSmokeProfile, runSmokeScenario } from './smoke.ts'
import { DESKTOP_SURFACE_CSS, desktopWindowOptions, rendererSurfaceState } from './native-window.ts'
import {
  isDesktopAppUrl,
  parseRendererId,
  parseRendererRequest,
  parseRendererSubscription,
  toRendererStreamEvent,
} from './renderer-ipc.ts'

const SCHEME = 'dsh'
const APP_ORIGIN = `${SCHEME}://app`
const require = createRequire(import.meta.url)

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

interface DesktopBoot {
  readonly rev: string
  readonly entries: ReadonlyArray<{
    readonly id: string
    readonly url: string
    readonly rev: string
    readonly inject?: string[]
    readonly immediately?: boolean
  }>
}

/** Spawn inputs shared by the development and packaged layouts. */
interface DshChildOptions {
  readonly cliEntry: string
  readonly cwd: string
  readonly execPath: string
  readonly execArgv: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

function packageDir(specifier: string): string {
  return dirname(require.resolve(`${specifier}/package.json`))
}

function tokenFor(id: string): string {
  return Buffer.from(id).toString('base64url')
}

function safeAssetPath(root: string, pathname: string): string | undefined {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  const path = resolve(root, requested)
  const rel = relative(root, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel) return undefined
  return path
}

function contentType(path: string): string | undefined {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    default: return undefined
  }
}

function registerAssetProtocol(webDist: string, bundles: ReadonlyMap<string, string>): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app' || request.method !== 'GET') return new Response('not found', { status: 404 })
    const bundleMatch = /^\/bundle\/([A-Za-z0-9_-]+)\.js$/.exec(url.pathname)
    const path = bundleMatch === null
      ? safeAssetPath(webDist, url.pathname)
      : bundles.get(bundleMatch[1] as string)
    if (path === undefined) return new Response('not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(path).href)
    const type = contentType(path)
    if (type === undefined) return response
    const headers = new Headers(response.headers)
    headers.set('content-type', type)
    // No CSP here for parity with the Web deployment, which serves the same
    // client without one: the client kernel evaluates `!!js` config through
    // `new Function`, so a strict header blanks the renderer. The renderer
    // runs sandboxed, context-isolated, and without Node; the preload bridge
    // is the security boundary. CSP hardening belongs to the carrier
    // completion issue (#5).
    return new Response(response.body, { status: response.status, headers })
  })
}

function spawnDshChild(options: DshChildOptions): { supervisor: DshSupervisor; childPid: number | undefined } {
  const child = fork(options.cliEntry, ['--profile', 'desktop'], {
    cwd: options.cwd,
    execPath: options.execPath,
    execArgv: [...options.execArgv],
    env: options.env,
    // JSON serialization: the desktop protocol validates JSON-shaped messages
    // at the boundary, and `advanced` (v8) serialization fails when Electron's
    // embedded V8 and the DSH child's Node differ in serialization version.
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(chunk) })
  return { supervisor: new DshSupervisor(child), childPid: child.pid }
}

/** Development layout: the child runs from the source tree like `dsh --profile desktop`. */
function developmentChildOptions(): DshChildOptions {
  const cli = resolve(packageDir('@deepseek-ai/dsh'), 'lib', 'bin.js')
  return {
    cliEntry: cli,
    cwd: resolve(fileURLToPath(new URL('../../..', import.meta.url))),
    execPath: process.env.DSH_NODE_EXECUTABLE ?? 'node',
    execArgv: [],
    env: process.env,
  }
}

/**
 * Packaged layout: the application binary itself is the child's Node runtime
 * (`ELECTRON_RUN_AS_NODE`), and the runtime closure ships as real files under
 * `Contents/Resources/runtime` so native modules and the PTY helper load from
 * filesystem paths. No system Node.js or DSH CLI participates.
 */
function packagedChildOptions(smoke: boolean): DshChildOptions {
  const layout = packagedRuntimeLayout(process.resourcesPath, app.getPath('userData'))
  mkdirSync(layout.childCwd, { recursive: true })
  const env = packagedChildEnv(process.env, layout.ptySpawnHelper)
  return {
    cliEntry: layout.cliEntry,
    cwd: layout.childCwd,
    execPath: process.execPath,
    execArgv: PACKAGED_CHILD_EXEC_ARGV,
    env: smoke && env['DSH_TELEMETRY_DISABLED'] === undefined
      ? { ...env, DSH_TELEMETRY_DISABLED: '1' }
      : env,
  }
}

function senderIs(window: BrowserWindow, event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.sender === window.webContents
    && event.senderFrame !== null
    && isDesktopAppUrl(event.senderFrame.url)
}

function installIpc(window: BrowserWindow, supervisor: DshSupervisor, boot: DesktopBoot): () => void {
  const assertSender = (event: IpcMainEvent | IpcMainInvokeEvent): void => {
    if (!senderIs(window, event)) throw new Error('desktop IPC rejected an unknown sender')
  }
  ipcMain.on('dsh:boot', (event) => {
    assertSender(event)
    event.returnValue = boot
  })
  ipcMain.handle('dsh:request', (event, value: unknown) => {
    assertSender(event)
    const request = parseRendererRequest(value)
    if (request === undefined) throw new Error('desktop IPC rejected a malformed request')
    return supervisor.request(request)
  })
  ipcMain.on('dsh:cancel-request', (event, value: unknown) => {
    assertSender(event)
    const id = parseRendererId(value)
    if (id === undefined) return
    supervisor.cancelRequest(id)
  })
  ipcMain.on('dsh:subscribe', (event, idValue: unknown, streamValue: unknown) => {
    assertSender(event)
    const subscription = parseRendererSubscription(idValue, streamValue)
    if (subscription === undefined) return
    supervisor.subscribe(subscription.id, subscription.stream)
  })
  ipcMain.on('dsh:cancel-subscription', (event, value: unknown) => {
    assertSender(event)
    const id = parseRendererId(value)
    if (id === undefined) return
    supervisor.cancelSubscription(id)
  })
  const stopStreams = supervisor.onStream((message) => {
    if (!window.isDestroyed()) window.webContents.send('dsh:stream', toRendererStreamEvent(message))
  })
  return () => {
    stopStreams()
    ipcMain.removeHandler('dsh:request')
    for (const channel of ['dsh:boot', 'dsh:cancel-request', 'dsh:subscribe', 'dsh:cancel-subscription']) {
      ipcMain.removeAllListeners(channel)
    }
  }
}

let quitting: Promise<void> | undefined

/** Boot the desktop window over a started supervisor. */
async function bootWindow(supervisor: DshSupervisor, webDist: string): Promise<BrowserWindow> {
  const ready = await supervisor.start()
  const bundlePaths = new Map(ready.bundles.map(bundle => [tokenFor(bundle.id), bundle.path]))
  const boot: DesktopBoot = {
    rev: ready.graph.rev,
    entries: ready.graph.entries.map(entry => ({
      ...entry,
      url: `${APP_ORIGIN}/bundle/${tokenFor(entry.id)}.js?rev=${entry.rev}`,
    })),
  }
  registerAssetProtocol(webDist, bundlePaths)

  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    ...desktopWindowOptions(process.platform),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isDesktopAppUrl(url)) event.preventDefault()
  })
  const removeIpc = installIpc(window, supervisor, boot)
  await window.loadURL(`${APP_ORIGIN}/index.html`)
  await window.webContents.insertCSS(DESKTOP_SURFACE_CSS)
  const applySurfaceState = (): void => {
    const state = rendererSurfaceState(
      nativeTheme.shouldUseDarkColors,
      nativeTheme.prefersReducedTransparency,
    )
    void window.webContents.executeJavaScript(`
      document.body.dataset.dshAppearance = ${JSON.stringify(state.appearance)};
      document.body.dataset.dshTransparency = ${JSON.stringify(state.transparency)};
    `).catch((error: unknown) => {
      console.error(`desktop appearance update failed: ${String(error)}`)
    })
  }
  applySurfaceState()
  nativeTheme.on('updated', applySurfaceState)
  window.once('closed', () => {
    nativeTheme.off('updated', applySurfaceState)
  })
  app.on('before-quit', (event) => {
    if (quitting !== undefined) return
    event.preventDefault()
    quitting = (async () => {
      removeIpc()
      await supervisor.stop().catch((error: unknown) => {
        console.error(`desktop DSH shutdown required force termination: ${String(error)}`)
      })
      app.quit()
    })()
  })

  app.on('window-all-closed', () => { app.quit() })
  return window
}

function onceWindowEvent(window: BrowserWindow, event: 'focus' | 'blur' | 'minimize' | 'restore'): Promise<void> {
  return new Promise((resolveEvent) => {
    const done = (): void => { resolveEvent() }
    switch (event) {
      case 'focus': window.once('focus', done); break
      case 'blur': window.once('blur', done); break
      case 'minimize': window.once('minimize', done); break
      case 'restore': window.once('restore', done); break
    }
  })
}

async function waitForRenderer(window: BrowserWindow, expression: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`) as boolean) return
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`desktop renderer did not satisfy ${expression}`)
}

/** One unary desktop-protocol request over the supervisor bridge. */
async function desktopRpc(
  supervisor: DshSupervisor,
  id: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await supervisor.request({
    type: 'request',
    id,
    url: `dsh://app/api/${method}`,
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
  })
  if (response.status !== 200) throw new Error(`desktop ${method} returned status ${String(response.status)}`)
  const parsed = JSON.parse(response.body) as {
    type: string
    result: { ok: true; value: unknown } | { ok: false; error: unknown }
  }
  if (parsed.type !== 'server-response' || !parsed.result.ok) {
    throw new Error(`desktop ${method} failed: ${JSON.stringify(parsed)}`)
  }
  return parsed.result.value as Record<string, unknown>
}

/** Click one renderer element with real pointer input at its measured center. */
async function clickAt(window: BrowserWindow, selector: string): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  })()`) as { x: number; y: number } | null
  if (point === null) throw new Error(`desktop acceptance: ${selector} has no clickable element`)
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
}

const WORKSPACE_MENU = '[role="menu"] [role="menuitem"], [role="menu"] button, [role="listbox"] [role="option"]'
const LIVE_COMPOSER = 'textarea:not([readonly]):not(:disabled)'

/** Pass the product's two named first-run gates through real pointer controls. */
async function completeOnboarding(window: BrowserWindow): Promise<void> {
  const dialog = '[role="dialog"]'
  const title = `${dialog} h2`
  await waitForRenderer(window, `document.querySelector(${JSON.stringify(title)})?.textContent?.trim() === 'Internal Testing Notice'`)
  await clickAt(window, `${dialog} button`)
  await waitForRenderer(window, `!document.querySelector(${JSON.stringify(dialog)}) || document.querySelector(${JSON.stringify(title)})?.textContent?.trim() === 'Add an API key to get started'`)
  const secondTitle = await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(title)})?.textContent?.trim()`) as string | undefined
  if (secondTitle === undefined) return
  if (secondTitle !== 'Add an API key to get started') {
    throw new Error(`desktop acceptance: unexpected onboarding dialog ${JSON.stringify(secondTitle)}`)
  }
  const configureLater = await window.webContents.executeJavaScript(`(() => Array.from(
    document.querySelectorAll(${JSON.stringify(`${dialog} button`)}),
    button => button.textContent?.trim(),
  ))()`) as unknown[]
  if (!configureLater.includes('Configure later')) {
    throw new Error('desktop acceptance: credential onboarding has no Configure later action')
  }
  const point = await window.webContents.executeJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll(${JSON.stringify(`${dialog} button`)}))
      .find(candidate => candidate.textContent?.trim() === 'Configure later');
    if (button === undefined) return null;
    const box = button.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  })()`) as { x: number; y: number } | null
  if (point === null) throw new Error('desktop acceptance: Configure later action has no clickable element')
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await waitForRenderer(window, `!document.querySelector(${JSON.stringify(dialog)})`)
}

/**
 * Reach the live composer through the real user journey: adopt a scratch
 * workspace over the desktop wire, open the hero workspace picker by clicking
 * the trigger, pick the workspace with pointer input, and land on the live
 * blank-session composer. Only real pointer input is used, because the
 * assembled client's own focus choreography outruns programmatic focus.
 */
async function reachLiveComposer(supervisor: DshSupervisor, window: BrowserWindow): Promise<void> {
  const workspaceDir = join(app.getPath('userData'), 'acceptance-workspace')
  await mkdir(workspaceDir, { recursive: true })
  const created = await desktopRpc(supervisor, 'accept-workspace', 'workspace.create', { path: workspaceDir })
  const workspace = created['workspace'] as Record<string, unknown>
  const workspaceId = String(workspace['workspaceId'])
  await desktopRpc(supervisor, 'accept-session', 'session.create', { workspaceId })
  // The assembled workspace store loads its baseline once during client boot;
  // reload after adoption so the real picker observes the workspace created by
  // this acceptance run rather than an intentionally stale empty snapshot.
  const loaded = new Promise<void>((resolveLoad) => {
    window.webContents.once('did-finish-load', () => { resolveLoad() })
  })
  window.webContents.reload()
  await loaded
  await window.webContents.insertCSS(DESKTOP_SURFACE_CSS)
  await waitForRenderer(window, "document.querySelector('#root > *') && document.querySelector('textarea')")

  await waitForRenderer(window, "document.querySelector('textarea[aria-haspopup]') && !document.querySelector('textarea').disabled")
  // The trigger textarea is pointer-inert by design; its capsule card is the
  // pick target that opens the workspace picker.
  await clickAt(window, '[data-composer-card]')
  await waitForRenderer(window, `document.querySelector(${JSON.stringify(WORKSPACE_MENU)})`, 5_000)
  // The portaled menu pre-renders offscreen until placement; only click a
  // row whose measured box is actually on screen.
  await waitForRenderer(window, "(() => { const row = document.querySelector('[role=\"menu\"] [role=\"menuitem\"], [role=\"listbox\"] [role=\"option\"]'); if (row === null) return false; const box = row.getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.top >= 0 && box.left >= 0; })()")
  await clickAt(window, '[role="menu"] [role="menuitem"], [role="listbox"] [role="option"]')
  await waitForRenderer(window, `document.querySelector(${JSON.stringify(LIVE_COMPOSER)})`)
}

/** Click the live composer for native focus and type through the real input-event path. */
async function typeIntoComposer(window: BrowserWindow): Promise<{ activeElement: string; value: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    window.focus()
    window.webContents.focus()
    await clickAt(window, LIVE_COMPOSER)
    try {
      await waitForRenderer(window, "document.activeElement?.tagName === 'TEXTAREA'", 1_000)
    } catch {
      continue
    }
    await window.webContents.insertText('KEYBOARD_OK')
    try {
      await waitForRenderer(window, `document.querySelector(${JSON.stringify(LIVE_COMPOSER)})?.value === 'KEYBOARD_OK'`, 1_000)
    } catch {
      continue
    }
    return await window.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector(${JSON.stringify(LIVE_COMPOSER)});
      return { activeElement: document.activeElement?.tagName, value: textarea.value };
    })()`) as { activeElement: string; value: string }
  }
  throw new Error('desktop acceptance: keyboard input never reached the live composer')
}

/** Exercise the installed app's assembled renderer and visible native window. */
async function acceptNativeWindow(supervisor: DshSupervisor, webDist: string): Promise<void> {
  const window = await bootWindow(supervisor, webDist)
  const focus: string[] = []
  const initialBounds = { x: 120, y: 120, width: 960, height: 700 }
  window.setBounds(initialBounds)
  window.show()
  window.focus()
  focus.push('active')
  window.on('focus', () => { focus.push('active') })
  window.on('blur', () => { focus.push('inactive') })

  let other: BrowserWindow | undefined
  try {
    await waitForRenderer(window, "document.querySelector('#root > *') && document.querySelector('textarea')")
    await completeOnboarding(window)
    const blurred = onceWindowEvent(window, 'blur')
    other = new BrowserWindow({ width: 240, height: 160, show: true })
    other.focus()
    await blurred
    const focused = onceWindowEvent(window, 'focus')
    window.focus()
    await focused

    const dragged = new Promise<void>((resolveMove) => { window.once('move', () => { resolveMove() }) })
    window.webContents.sendInputEvent({ type: 'mouseDown', x: 480, y: 20, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 520, y: 60, movementX: 40, movementY: 40 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 520, y: 60, button: 'left', clickCount: 1 })
    await Promise.race([dragged, new Promise(resolveWait => setTimeout(resolveWait, 1_000))])
    const draggedBounds = window.getBounds()

    await reachLiveComposer(supervisor, window)
    const keyboardBeforeMinimize = await typeIntoComposer(window)
    const controlBounds = window.getBounds()

    const minimized = onceWindowEvent(window, 'minimize')
    window.minimize()
    await minimized
    const wasMinimized = window.isMinimized()
    const restored = onceWindowEvent(window, 'restore')
    window.restore()
    await restored

    const renderer = await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('#root');
      const textarea = document.querySelector('textarea');
      const box = root.getBoundingClientRect();
      return {
        assembled: root.childElementCount > 0,
        root: {
          top: box.top,
          bottom: box.bottom,
          height: box.height,
        },
        viewportHeight: innerHeight,
        dragRegion: getComputedStyle(document.body, '::before').webkitAppRegion,
        controlRegion: getComputedStyle(textarea).webkitAppRegion,
        activeElement: document.activeElement?.tagName,
        keyboardValue: textarea.value,
      };
    })()`) as unknown
    console.log(`NATIVE_WINDOW_ACCEPTANCE ${JSON.stringify({
      focus,
      window: {
        initialBounds,
        draggedBounds,
        controlBounds,
        minimized: wasMinimized,
        restored: !window.isMinimized(),
      },
      renderer: { ...(renderer as Record<string, unknown>), keyboardBeforeMinimize },
    })}`)
  } finally {
    other?.destroy()
    window.destroy()
    await supervisor.stop()
  }
}

/** Parse the `--smoke-replay <file>` value of a recording invocation. */
function parseReplayArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--smoke-replay') continue
    const value = argv[index + 1]
    if (typeof value === 'string' && value !== '' && !value.startsWith('-')) return value
  }
  return undefined
}

/**
 * Record truthful renderer frames of the real packaged window: launch, focus
 * transitions, the drag-strip input attempt, keyboard operation, minimize/
 * restore, light/dark appearance, and the replayed tracer-bullet turn in the
 * assembled UI. `capturePage()` sees renderer pixels only, so native
 * traffic-light glyphs and OS-level drag movement are out of frame; the
 * evidence line reports the native window state beside the frame list.
 * Requires `--record-native-window --smoke-replay <file>` plus an explicit
 * `DSH_DESKTOP_FRAMES_DIR`; restores the entry `nativeTheme.themeSource`.
 */
async function recordNativeWindow(
  supervisor: DshSupervisor,
  childPid: number | undefined,
  webDist: string,
): Promise<void> {
  const framesDir = process.env.DSH_DESKTOP_FRAMES_DIR
  if (framesDir === undefined || framesDir.trim() === '') {
    throw new Error('desktop recording requires DSH_DESKTOP_FRAMES_DIR so frames never touch the owner\'s home')
  }
  await mkdir(framesDir, { recursive: true })
  const window = await bootWindow(supervisor, webDist)
  const frames: string[] = []
  let frameIndex = 0
  const capture = async (label: string): Promise<void> => {
    frameIndex += 1
    const image = await window.webContents.capturePage()
    const name = `${String(frameIndex).padStart(2, '0')}-${label}.png`
    await writeFile(join(framesDir, name), image.toPNG())
    frames.push(name)
  }
  const focus: string[] = []
  const initialBounds = { x: 120, y: 120, width: 960, height: 700 }
  window.setBounds(initialBounds)
  window.show()
  window.focus()
  focus.push('active')
  window.on('focus', () => { focus.push('active') })
  window.on('blur', () => { focus.push('inactive') })

  let other: BrowserWindow | undefined
  const originalThemeSource = nativeTheme.themeSource
  let scenarioFailure: string | null = null
  let capturing = true
  try {
    await waitForRenderer(window, "document.querySelector('#root > *') && document.querySelector('textarea')")
    await capture('launch')
    await completeOnboarding(window)

    const blurred = onceWindowEvent(window, 'blur')
    other = new BrowserWindow({ width: 240, height: 160, show: true })
    other.focus()
    await blurred
    await capture('inactive')
    const focused = onceWindowEvent(window, 'focus')
    window.focus()
    await focused
    await capture('active')

    // Synthetic input exercises the drag strip without OS-level pointer
    // permissions; the evidence line records the resulting bounds.
    window.webContents.sendInputEvent({ type: 'mouseDown', x: 480, y: 20, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 520, y: 60, movementX: 40, movementY: 40 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 520, y: 60, button: 'left', clickCount: 1 })
    const dragAttemptBounds = window.getBounds()
    await capture('drag-strip-attempt')

    await reachLiveComposer(supervisor, window)
    const keyboard = await typeIntoComposer(window)
    const controlBounds = window.getBounds()
    await capture('keyboard-typed')

    const minimized = onceWindowEvent(window, 'minimize')
    window.minimize()
    await minimized
    const wasMinimized = window.isMinimized()
    const restored = onceWindowEvent(window, 'restore')
    window.restore()
    await restored
    await capture('restored')

    nativeTheme.themeSource = 'dark'
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    await capture('appearance-dark')
    nativeTheme.themeSource = 'light'
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    await capture('appearance-light')

    // The tracer bullet: replay the recorded turn through the assembled
    // renderer while polling frames, so the frames show the real session and
    // streamed transcript rather than a synthetic page.
    const poll = (async () => {
      while (capturing) {
        await capture('tracer-turn')
        await new Promise(resolveWait => setTimeout(resolveWait, 400))
      }
    })()
    try {
      await runSmokeScenario(supervisor, childPid ?? process.pid)
    } catch (error) {
      scenarioFailure = error instanceof Error ? error.message : String(error)
    } finally {
      capturing = false
    }
    await poll
    await capture('tracer-settled')

    console.log(`NATIVE_WINDOW_RECORDING ${JSON.stringify({
      framesDir,
      frames,
      focus,
      window: {
        initialBounds,
        dragAttemptBounds,
        controlBounds,
        minimized: wasMinimized,
        restored: !window.isMinimized(),
      },
      keyboard,
      scenarioFailure,
    })}`)
  } finally {
    nativeTheme.themeSource = originalThemeSource
    other?.destroy()
    window.destroy()
    await supervisor.stop()
  }
}

/** Print native and renderer state from a real BrowserWindow for automated acceptance. */
async function inspectNativeWindow(): Promise<void> {
  const options = desktopWindowOptions(process.platform)
  const window = new BrowserWindow({
    width: 960,
    height: 700,
    show: false,
    ...options,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  try {
    await window.loadURL('data:text/html,<button id="control">Control</button><textarea id="editor"></textarea>')
    await window.webContents.insertCSS(DESKTOP_SURFACE_CSS)
    const state = rendererSurfaceState(nativeTheme.shouldUseDarkColors, nativeTheme.prefersReducedTransparency)
    const renderer = await window.webContents.executeJavaScript(`
      const inspectSurface = (appearance, transparency) => {
        document.body.toggleAttribute('data-ds-dark-theme', appearance === 'dark');
        document.body.dataset.dshAppearance = appearance;
        document.body.dataset.dshTransparency = transparency;
        return getComputedStyle(document.body).backgroundColor;
      };
      document.querySelector('#control').focus();
      ({
        activeElement: document.activeElement?.id,
        systemState: ${JSON.stringify(state)},
        surfaces: {
          lightEnabled: inspectSurface('light', 'enabled'),
          darkEnabled: inspectSurface('dark', 'enabled'),
          lightReduced: inspectSurface('light', 'reduced'),
          darkReduced: inspectSurface('dark', 'reduced'),
        },
        controlRegion: getComputedStyle(document.querySelector('#control')).webkitAppRegion,
        dragRegion: getComputedStyle(document.body, '::before').webkitAppRegion,
      })
    `) as unknown
    console.log(`NATIVE_WINDOW_STATE ${JSON.stringify({
      options,
      actual: {
        backgroundColor: window.getBackgroundColor(),
        focusable: window.isFocusable(),
      },
      renderer,
    })}`)
  } finally {
    window.destroy()
  }
}

/**
 * Keyless smoke mode: run the Session → terminal command → streamed output →
 * quit-cleanup tracer bullet without a window and exit with the scenario's
 * verdict. The packaged-app smoke test launches the installed application
 * binary with `--smoke --smoke-replay <file>`.
 */
async function bootSmoke(supervisor: DshSupervisor, childPid: number | undefined): Promise<number> {
  try {
    await runSmokeScenario(supervisor, childPid ?? process.pid)
    console.log('SMOKE_PASS')
    return 0
  } catch (error) {
    console.error(`desktop smoke failed: ${error instanceof Error ? error.message : String(error)}`)
    // A stop failure is secondary to the scenario verdict already in hand, so
    // report it by name instead of masking the original error.
    await supervisor.stop().catch((stopError: unknown) => {
      console.error(`desktop smoke: stopping the child also failed: ${String(stopError)}`)
    })
    return 1
  }
}

// Electron does not emit `ready` while an ESM main module is still
// evaluating, so a top-level `await app.whenReady()` deadlocks boot: the
// promise below lets module evaluation finish first, then runs the app.
void app.whenReady().then(() => {
  void (async () => {
    if (process.argv.includes('--inspect-native-window')) {
      await inspectNativeWindow()
      app.exit(0)
      return
    }
    const acceptance = process.argv.includes('--accept-native-window')
    const recording = process.argv.includes('--record-native-window')
    const smoke = parseSmokeInvocation(process.argv)
    const options = app.isPackaged ? packagedChildOptions(smoke !== undefined || recording) : developmentChildOptions()
    if (recording) {
      const replayFile = parseReplayArg(process.argv)
      if (replayFile === undefined) {
        console.error('desktop recording requires --smoke-replay <file>')
        app.exit(1)
        return
      }
      // The recording drives the same keyless replay profile as the smoke:
      // the assembled renderer must display a real session, never a mock.
      const replayProvider = app.isPackaged
        ? packagedRuntimeLayout(process.resourcesPath, app.getPath('userData')).replayProvider
        : packageDir('@deepseek-ai/dsh-llm-replay')
      prepareSmokeProfile(replayFile, replayProvider)
      const webDist = app.isPackaged
        ? packagedRuntimeLayout(process.resourcesPath, app.getPath('userData')).webDist
        : resolve(packageDir('@deepseek-ai/dsh-web-frontend'), 'dist')
      const { supervisor, childPid } = spawnDshChild(options)
      await recordNativeWindow(supervisor, childPid, webDist)
      app.exit(0)
      return
    }
    if (smoke !== undefined) {
      const replayFile = smoke.replayFile
      if (replayFile === undefined) {
        console.error('desktop smoke requires --smoke-replay <file>')
        app.exit(1)
        return
      }
      // The child reads its profile at boot, so the smoke profile (bundles +
      // keyless replay patch + the fallback link to the replay provider) must
      // exist before the child spawns.
      const replayProvider = app.isPackaged
        ? packagedRuntimeLayout(process.resourcesPath, app.getPath('userData')).replayProvider
        : packageDir('@deepseek-ai/dsh-llm-replay')
      prepareSmokeProfile(replayFile, replayProvider)
      const { supervisor, childPid } = spawnDshChild(options)
      app.exit(await bootSmoke(supervisor, childPid))
      return
    }
    const webDist = app.isPackaged
      ? packagedRuntimeLayout(process.resourcesPath, app.getPath('userData')).webDist
      : resolve(packageDir('@deepseek-ai/dsh-web-frontend'), 'dist')
    const { supervisor } = spawnDshChild(options)
    if (acceptance) {
      await acceptNativeWindow(supervisor, webDist)
      app.exit(0)
      return
    }
    await bootWindow(supervisor, webDist)
  })().catch((error: unknown) => {
    console.error(`desktop app failed to start: ${String(error)}`)
    app.exit(1)
  })
})
