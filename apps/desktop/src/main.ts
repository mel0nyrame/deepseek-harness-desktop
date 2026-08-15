/** Electron desktop entry: development shell and packaged application. */

import { fork } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol,
  type IpcMainEvent, type IpcMainInvokeEvent,
} from 'electron'
import { DshSupervisor } from './supervisor.ts'
import { DesktopLifecycle, type HostPhase, type StopReport } from './lifecycle.ts'
import { createProcessTreeLadder } from './process-tree.ts'
import { DESKTOP_STATUS_HTML, STATUS_PAGE_PATH, statusStateFor } from './status.ts'
import { RendererStreamRelay } from './renderer-stream-relay.ts'
import { desktopRpc, discoverAcceptanceSession } from './acceptance.ts'
import {
  PACKAGED_CHILD_EXEC_ARGV,
  packagedChildEnv,
  packagedRuntimeLayout,
  parseSmokeInvocation,
} from './packaged-runtime.ts'
import { prepareBrokenProfile, prepareSmokeProfile, RECORDED_PROMPT, runSmokeScenario } from './smoke.ts'
import { DESKTOP_SURFACE_CSS, desktopWindowOptions, rendererSurfaceState } from './native-window.ts'
import {
  isDesktopAppUrl,
  parseRendererId,
  parseRendererRecoveryAction,
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

/** Default grace for Host startup and shutdown, overridable for tests. */
function desktopTimeoutMs(envName: string, fallback: number): number {
  const raw = process.env[envName]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

const STARTUP_TIMEOUT_MS = desktopTimeoutMs('DSH_DESKTOP_STARTUP_TIMEOUT_MS', 30_000)
const SHUTDOWN_TIMEOUT_MS = desktopTimeoutMs('DSH_DESKTOP_SHUTDOWN_TIMEOUT_MS', 15_000)

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
  readonly bundleRoot: string
  readonly cwd: string
  readonly execPath: string
  readonly execArgv: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

/** One spawned DSH generation plus its failure context. */
interface DshSpawn {
  readonly supervisor: DshSupervisor
  readonly childPid: number | undefined
  readonly tail: () => string
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

/** Client bundle paths announced by the running generation, keyed by token. */
const servedBundles = new Map<string, string>()

function registerAssetProtocol(webDist: string): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app' || request.method !== 'GET') return new Response('not found', { status: 404 })
    if (url.pathname === STATUS_PAGE_PATH) {
      return new Response(DESKTOP_STATUS_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    const bundleMatch = /^\/bundle\/([A-Za-z0-9_-]+)\.js$/.exec(url.pathname)
    const path = bundleMatch === null
      ? safeAssetPath(webDist, url.pathname)
      : servedBundles.get(bundleMatch[1] as string)
    if (path === undefined) return new Response('not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(path).href)
    const type = contentType(path)
    if (type === undefined) return response
    const headers = new Headers(response.headers)
    headers.set('content-type', type)
    // The shared client evaluates `!!js` config through `new Function`, so a
    // strict CSP would blank both carriers. Renderer isolation and the narrow
    // preload bridge remain the Electron carrier's security boundary.
    return new Response(response.body, { status: response.status, headers })
  })
}

/**
 * Spawn one DSH generation. The child runs detached, leading its own process
 * group and session, so the shutdown ladder can still identify and signal
 * descendants and PTYs after the immediate parent exits.
 */
function spawnDshChild(options: DshChildOptions): DshSpawn {
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
    detached: true,
  })
  child.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(chunk) })
  const stderrTail: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
    stderrTail.push(String(chunk))
    if (stderrTail.length > 40) stderrTail.shift()
  })
  // fork()'s ChildProcess overloads are looser than the narrow supervisor
  // surface; this view pins exactly the members the supervisor may touch and
  // reads mutable child state live through getters.
  const dshChild = {
    get pid() { return child.pid },
    get connected() { return child.connected },
    get exitCode() { return child.exitCode },
    get signalCode() { return child.signalCode },
    send: child.send.bind(child),
    kill: child.kill.bind(child),
    on: child.on.bind(child),
    off: child.off.bind(child),
  } as import('./supervisor.ts').DshChild
  const tree = createProcessTreeLadder()
  const supervisor = new DshSupervisor(dshChild, {
    bundleRoot: options.bundleRoot,
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    ...(tree === undefined ? {} : { tree }),
  })
  return { supervisor, childPid: child.pid, tail: () => stderrTail.join('') }
}

/** Development layout: the child runs from the source tree like `dsh --profile desktop`. */
function developmentChildOptions(): DshChildOptions {
  const cli = resolve(packageDir('@deepseek-ai/dsh'), 'lib', 'bin.js')
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  return {
    cliEntry: cli,
    bundleRoot: repoRoot,
    cwd: repoRoot,
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
    bundleRoot: layout.runtimeRoot,
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
    && event.senderFrame === window.webContents.mainFrame
    && isDesktopAppUrl(event.senderFrame.url)
}

/** The boot payload of the current running generation, for `dsh:boot`. */
let currentBoot: DesktopBoot | undefined

function refreshBoot(lifecycle: DesktopLifecycle): void {
  const ready = lifecycle.bootInfo
  if (ready === undefined) {
    currentBoot = undefined
    return
  }
  servedBundles.clear()
  for (const bundle of ready.bundles) servedBundles.set(tokenFor(bundle.id), bundle.path)
  currentBoot = {
    rev: ready.graph.rev,
    entries: ready.graph.entries.map(entry => ({
      ...entry,
      url: `${APP_ORIGIN}/bundle/${tokenFor(entry.id)}.js?rev=${entry.rev}`,
    })),
  }
}

function installIpc(window: BrowserWindow, lifecycle: DesktopLifecycle): () => void {
  const webContents = window.webContents
  const senderAllowed = (event: IpcMainEvent): boolean => {
    if (senderIs(window, event)) return true
    console.error('[desktop-main] dropped IPC from an unknown sender')
    return false
  }
  const assertInvokeSender = (event: IpcMainInvokeEvent): void => {
    if (!senderIs(window, event)) throw new Error('desktop IPC rejected an unknown sender')
  }
  const statusSenderAllowed = (event: IpcMainInvokeEvent): boolean => {
    if (!senderIs(window, event) || event.senderFrame === null) return false
    const url = new URL(event.senderFrame.url)
    return url.pathname === STATUS_PAGE_PATH
  }
  const supervisorOf = (): DshSupervisor => {
    const current = lifecycle.current()
    if (current === undefined) throw new Error('desktop IPC reached with no DSH generation')
    return current.supervisor
  }
  // .on handlers cannot throw into Electron; a phase without a generation
  // simply drops the stale renderer call.
  const maybeSupervisor = (): DshSupervisor | undefined => lifecycle.current()?.supervisor
  const relay = new RendererStreamRelay(
    (message) => {
      if (window.isDestroyed()) return false
      try {
        window.webContents.send('dsh:stream', message)
        return true
      } catch (error: unknown) {
        console.error('[desktop-main] renderer stream send failed:', error)
        return false
      }
    },
    (id) => { maybeSupervisor()?.cancelSubscription(id) },
  )
  ipcMain.on('dsh:boot', (event) => {
    if (!senderAllowed(event)) return
    event.returnValue = currentBoot ?? null
  })
  ipcMain.handle('dsh:request', (event, value: unknown) => {
    assertInvokeSender(event)
    const request = parseRendererRequest(value)
    if (request === undefined) throw new Error('desktop IPC rejected a malformed request')
    return supervisorOf().request(request)
  })
  ipcMain.on('dsh:cancel-request', (event, value: unknown) => {
    if (!senderAllowed(event)) return
    const id = parseRendererId(value)
    if (id === undefined) {
      console.error('[desktop-main] dropped malformed request cancellation')
      return
    }
    maybeSupervisor()?.cancelRequest(id)
  })
  ipcMain.on('dsh:subscribe', (event, idValue: unknown, streamValue: unknown) => {
    if (!senderAllowed(event)) return
    const subscription = parseRendererSubscription(idValue, streamValue)
    if (subscription === undefined) {
      console.error('[desktop-main] dropped malformed subscription')
      return
    }
    maybeSupervisor()?.subscribe(subscription.id, subscription.stream)
  })
  ipcMain.on('dsh:cancel-subscription', (event, value: unknown) => {
    if (!senderAllowed(event)) return
    const id = parseRendererId(value)
    if (id === undefined) {
      console.error('[desktop-main] dropped malformed subscription cancellation')
      return
    }
    relay.clear(id)
    maybeSupervisor()?.cancelSubscription(id)
  })
  ipcMain.on('dsh:stream-ack', (event, value: unknown) => {
    if (!senderAllowed(event)) return
    const id = parseRendererId(value)
    if (id === undefined) {
      console.error('[desktop-main] dropped malformed stream acknowledgement')
      return
    }
    relay.ack(id)
  })
  ipcMain.handle('dsh:recovery', (event, value: unknown) => {
    if (!statusSenderAllowed(event)) throw new Error('desktop IPC rejected an unknown recovery sender')
    const action = parseRendererRecoveryAction(value)
    if (action === undefined) throw new Error('desktop IPC rejected a malformed recovery action')
    if (action === 'quit') {
      app.quit()
      return
    }
    void lifecycle.restart().catch((error: unknown) => {
      console.error(`desktop recovery restart failed: ${String(error)}`)
    })
  })
  const disconnectRenderer = (): void => {
    relay.clearAll()
    const current = lifecycle.current()
    current?.supervisor.disconnectRenderer()
  }
  const onNavigation = (): void => { disconnectRenderer() }
  webContents.on('render-process-gone', disconnectRenderer)
  webContents.on('destroyed', disconnectRenderer)
  webContents.on('did-navigate', onNavigation)
  // Stream forwarding follows the current generation: re-attach whenever the
  // lifecycle spawns or settles a generation.
  let stopStreams = (): void => {}
  const attachStreams = (): void => {
    stopStreams()
    const current = lifecycle.current()
    if (current !== undefined) {
      stopStreams = current.supervisor.onStream((message) => {
        relay.push(toRendererStreamEvent(message))
      })
    }
  }
  const detachPhase = lifecycle.onPhase(attachStreams)
  attachStreams()
  return () => {
    detachPhase()
    stopStreams()
    relay.clearAll()
    if (!webContents.isDestroyed()) {
      webContents.off('render-process-gone', disconnectRenderer)
      webContents.off('destroyed', disconnectRenderer)
      webContents.off('did-navigate', onNavigation)
    }
    ipcMain.removeHandler('dsh:request')
    ipcMain.removeHandler('dsh:recovery')
    for (const channel of ['dsh:boot', 'dsh:cancel-request', 'dsh:subscribe', 'dsh:cancel-subscription', 'dsh:stream-ack']) {
      ipcMain.removeAllListeners(channel)
    }
  }
}

/** Serialize page transitions for one window: status page ↔ assembled app. */
function pageDirector(window: BrowserWindow) {
  let queue: Promise<void> = Promise.resolve()
  const run = (transition: () => Promise<void>): void => {
    queue = queue.then(transition).catch((error: unknown) => {
      console.error('[desktop-main] page transition failed:', error)
    })
  }
  const atPath = (pathname: string): boolean => {
    if (window.isDestroyed()) return false
    const current = window.webContents.getURL()
    return isDesktopAppUrl(current) && new URL(current).pathname === pathname
  }
  const ensure = async (pathname: string): Promise<void> => {
    if (atPath(pathname)) return
    await window.loadURL(`${APP_ORIGIN}${pathname}`)
    await window.webContents.insertCSS(DESKTOP_SURFACE_CSS)
  }
  return {
    status(state: ReturnType<typeof statusStateFor>): void {
      run(async () => {
        await ensure(STATUS_PAGE_PATH)
        await window.webContents.executeJavaScript(
          `window.renderStatus(${JSON.stringify(state)})`,
        ).catch((error: unknown) => {
          console.error(`desktop status render failed: ${String(error)}`)
        })
      })
    },
    app(): void {
      run(async () => {
        await ensure('/index.html')
      })
    },
  }
}

/** Boot the desktop window over the lifecycle owner and start the Host. */
function bootWindow(
  lifecycle: DesktopLifecycle,
): { window: BrowserWindow; ready: Promise<void> } {
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
  currentWindow = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isDesktopAppUrl(url)) event.preventDefault()
  })
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
    if (currentWindow === window) currentWindow = undefined
    nativeTheme.off('updated', applySurfaceState)
  })
  app.on('window-all-closed', () => { app.quit() })

  const removeIpc = installIpc(window, lifecycle)
  const pages = pageDirector(window)
  window.once('closed', () => { removeIpc() })

  // Wire every lifecycle phase to the defined user-visible surface.
  const reflectPhase = (phase: HostPhase): void => {
    switch (phase) {
      case 'running':
        refreshBoot(lifecycle)
        pages.app()
        return
      case 'starting':
      case 'recovering':
      case 'failed':
      case 'stopping':
        pages.status(statusStateFor(phase, lifecycle.failure, lifecycle.restartAvailable))
        return
      case 'stopped':
        return
    }
  }
  const removePhase = lifecycle.onPhase(reflectPhase)
  const removeFailure = lifecycle.onFailure(() => {
    const phase = lifecycle.phase
    if (phase === 'failed' || phase === 'recovering') {
      pages.status(statusStateFor(phase, lifecycle.failure, lifecycle.restartAvailable))
    }
  })
  window.once('closed', () => {
    removePhase()
    removeFailure()
  })
  pages.status(statusStateFor('starting'))

  const ready = lifecycle.start()
  return { window, ready }
}

let quitting: Promise<void> | undefined
let quitArmed = false
let currentWindow: BrowserWindow | undefined

/** Describe a failed cleanup without ever claiming success. */
function formatCleanupFailure(report: StopReport): string {
  const failure = report.failure
  if (failure === undefined) return 'shutdown incomplete'
  const survivors = failure.survivors === undefined
    ? ''
    : `\n${failure.survivors.map(survivor => `pid ${String(survivor.pid)}: ${survivor.command}`).join('\n')}`
  return `${failure.message}${survivors}`
}

/**
 * The one application quit owner: every quit path funnels through the
 * lifecycle's terminate-and-join ladder before the process may complete, and
 * an incomplete cleanup surfaces actionably instead of reporting success.
 */
function installQuitOwner(
  lifecycle: DesktopLifecycle,
  getWindow: () => BrowserWindow | undefined,
  headless: boolean,
): void {
  app.on('before-quit', (event) => {
    if (quitArmed) return
    event.preventDefault()
    quitting ??= (async () => {
      const report = await lifecycle.stop()
      if (!report.quiescent) {
        const message = formatCleanupFailure(report)
        console.error(`[desktop-main] shutdown incomplete: ${message}`)
        console.error(`CLEANUP_INCOMPLETE ${JSON.stringify(report.failure)}`)
        if (!headless) {
          const window = getWindow()
          if (window !== undefined && !window.isDestroyed()) {
            await dialog.showMessageBox(window, {
              type: 'error',
              title: 'DSH Desktop',
              message: 'The DSH runtime did not shut down cleanly',
              detail: message,
              buttons: ['Force Quit'],
            })
          }
        }
        process.exitCode = 1
      }
      quitArmed = true
      app.quit()
    })()
  })
}

/** Stop the lifecycle after an acceptance or recording journey. */
async function stopAfterJourney(lifecycle: DesktopLifecycle, headless: boolean): Promise<void> {
  const report = await lifecycle.stop()
  if (!report.quiescent) {
    console.error(`[desktop-main] shutdown incomplete: ${formatCleanupFailure(report)}`)
    console.error(`CLEANUP_INCOMPLETE ${JSON.stringify(report.failure)}`)
    if (!headless) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'DSH Desktop',
        message: 'The DSH runtime did not shut down cleanly',
        detail: formatCleanupFailure(report),
        buttons: ['Force Quit'],
      })
    }
    process.exitCode = 1
  }
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

const LIVE_COMPOSER = 'textarea:not([readonly]):not(:disabled)'
const SETTLED_BASH_CARD = '[data-sample="bash"][data-state="ok"]'

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
 *
 * The pick itself mints the session: the picker's `connectWorkspace` reuses a
 * blank session only when its reuse scan can already see one, and pre-creating
 * a session over the wire races that scan (the pick then mints a second one
 * and the composer submits to the minted id while the driver polls the
 * pre-created one). This journey therefore returns the session the real pick
 * opened, discovered through the durable workspace view.
 */
async function reachLiveComposer(supervisor: DshSupervisor, window: BrowserWindow): Promise<string> {
  const workspaceDir = join(app.getPath('userData'), 'acceptance-workspace')
  await mkdir(workspaceDir, { recursive: true })
  const created = await desktopRpc(supervisor, 'accept-workspace', 'workspace.create', { path: workspaceDir })
  const workspace = created['workspace'] as Record<string, unknown>
  const workspaceId = String(workspace['workspaceId'])
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
  // pick target that opens the workspace picker. The trigger's aria-expanded
  // mirrors the owner's picker-open state even while the menu renders nothing
  // (the workspace baseline and the directory-flow occupant mount
  // asynchronously after boot), so click until the picker is genuinely open —
  // re-clicking an open picker toggles it closed, so an open state without a
  // rendered menu must never be re-clicked.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await clickAt(window, '[data-composer-card]')
      await waitForRenderer(window, "document.querySelector('textarea[aria-expanded=\"true\"]')", 1_000)
      break
    } catch (error) {
      if (attempt === 9) throw error
    }
  }
  // The portaled menu pre-renders offscreen until placement; only click a
  // row whose measured box is actually on screen.
  await waitForRenderer(window, "(() => { const row = document.querySelector('[role=\"menu\"] [role=\"menuitem\"], [role=\"listbox\"] [role=\"option\"]'); if (row === null) return false; const box = row.getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.top >= 0 && box.left >= 0; })()")
  await clickAt(window, '[role="menu"] [role="menuitem"], [role="listbox"] [role="option"]')
  await waitForRenderer(window, `document.querySelector(${JSON.stringify(LIVE_COMPOSER)})`)
  return discoverAcceptanceSession(supervisor, workspaceId)
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

/** Replace the live draft and submit it through the renderer's real Enter path. */
async function submitRecordedPrompt(window: BrowserWindow): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    window.focus()
    window.webContents.focus()
    await clickAt(window, LIVE_COMPOSER)
    // The synthetic click and the surrounding focus choreography schedule the
    // app's own frames; a select-all issued before they settle can collapse
    // again between the select and the insert, turning the replacement into a
    // concatenation. Flush pending animation frames first so the selection
    // survives, then verify the exact draft before committing to the send.
    await window.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))',
    )
    const selected = await window.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector(${JSON.stringify(LIVE_COMPOSER)});
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      textarea.select();
      return document.activeElement === textarea && textarea.selectionStart === 0 && textarea.selectionEnd === textarea.value.length;
    })()`) as boolean
    if (!selected) throw new Error('desktop recording: the live composer draft could not be selected')
    await window.webContents.insertText(RECORDED_PROMPT)
    try {
      await waitForRenderer(
        window,
        `document.querySelector(${JSON.stringify(LIVE_COMPOSER)})?.value === ${JSON.stringify(RECORDED_PROMPT)}`,
        2_000,
      )
      break
    } catch (error) {
      if (attempt === 2) {
        const observed = await window.webContents.executeJavaScript(`(() => {
          const textarea = document.querySelector(${JSON.stringify(LIVE_COMPOSER)});
          return {
            value: textarea instanceof HTMLTextAreaElement ? textarea.value : null,
            activeElement: document.activeElement?.tagName ?? null,
            hasFocus: document.hasFocus(),
          };
        })()`) as unknown
        throw new Error(
          `desktop recording: the prompt never landed in the live composer; observed ${JSON.stringify(observed)}`,
          { cause: error },
        )
      }
    }
  }
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await waitForRenderer(window, `document.querySelector(${JSON.stringify(LIVE_COMPOSER)})?.value === ''`)
}

interface RecordedHistoryEvent {
  readonly type: string
  readonly data?: unknown
}

/** Verify the replayed turn through durable history and its rendered bash card. */
async function waitForRecordedTurn(
  supervisor: DshSupervisor,
  window: BrowserWindow,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 60_000
  let requestIndex = 0
  let events: RecordedHistoryEvent[] = []
  for (;;) {
    requestIndex += 1
    const history = await desktopRpc(supervisor, `record-history-${String(requestIndex)}`, 'session.history', {
      sessionId,
      maxMessages: 50,
    })
    const entries = history['events']
    if (!Array.isArray(entries)) throw new Error('desktop recording: session.history returned no events')
    events = entries.flatMap((entry): RecordedHistoryEvent[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const event = (entry as { event?: unknown }).event
      if (typeof event !== 'object' || event === null || typeof (event as { type?: unknown }).type !== 'string') return []
      return [event as RecordedHistoryEvent]
    })
    const hasToolResult = events.some(event => event.type === 'tool/result')
    const hasTurnEnd = events.some(event => event.type === 'turn/end')
    const bashSettled = await window.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(SETTLED_BASH_CARD)}))`,
    ) as boolean
    if (hasToolResult && hasTurnEnd && bashSettled) break
    if (Date.now() > deadline) {
      throw new Error(`desktop recording scenario did not settle; events: ${JSON.stringify(events).slice(0, 4000)}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }

  const toolCall = events.find(event => event.type === 'tool/call') as { data?: { name?: unknown } } | undefined
  if (toolCall?.data?.name !== 'bash') throw new Error('desktop recording: the replayed turn did not call bash')
  const toolResult = events.find(event => event.type === 'tool/result') as {
    data?: { message?: { content?: Array<{ type?: unknown; content?: unknown[] }> } }
  } | undefined
  const terminalText = toolResult?.data?.message?.content
    ?.filter(part => part.type === 'tool-result')
    .flatMap(part => part.content ?? [])
    .filter(entry => typeof entry === 'object'
      && entry !== null
      && (entry as { type?: unknown }).type === 'text'
      && typeof (entry as { text?: unknown }).text === 'string')
    .map(entry => (entry as { text: string }).text)
    .join('') ?? ''
  if (!terminalText.includes('TERMINAL_OK')) {
    throw new Error('desktop recording: the bash result did not contain TERMINAL_OK')
  }
  console.log('SMOKE_OK terminal')
}

/** Exercise the installed app's assembled renderer and visible native window. */
async function acceptNativeWindow(lifecycle: DesktopLifecycle): Promise<void> {
  const { window, ready } = bootWindow(lifecycle)
  await ready
  if (lifecycle.phase !== 'running') {
    throw new Error(`desktop acceptance: Host did not reach the running phase (${lifecycle.phase})`)
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

    await reachLiveComposer(currentSupervisor(lifecycle), window)
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
    await stopAfterJourney(lifecycle, true)
  }
}

interface FrameRecorder {
  readonly frames: string[]
  capture(label: string): Promise<void>
}

/** Write numbered `capturePage()` PNG frames into one evidence directory. */
function createFrameRecorder(window: BrowserWindow, framesDir: string): FrameRecorder {
  const frames: string[] = []
  let frameIndex = 0
  return {
    frames,
    async capture(label) {
      frameIndex += 1
      const image = await window.webContents.capturePage()
      const name = `${String(frameIndex).padStart(2, '0')}-${label}.png`
      await writeFile(join(framesDir, name), image.toPNG())
      frames.push(name)
    },
  }
}

/** Require the current generation's supervisor, or fail with the lifecycle context. */
function currentSupervisor(lifecycle: DesktopLifecycle): DshSupervisor {
  const current = lifecycle.current()
  if (current === undefined) throw new Error('desktop recording: no DSH generation after start')
  return current.supervisor
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
  lifecycle: DesktopLifecycle,
): Promise<void> {
  const framesDir = process.env.DSH_DESKTOP_FRAMES_DIR
  if (framesDir === undefined || framesDir.trim() === '') {
    throw new Error('desktop recording requires DSH_DESKTOP_FRAMES_DIR so frames never touch the owner\'s home')
  }
  await mkdir(framesDir, { recursive: true })
  const { window, ready } = bootWindow(lifecycle)
  await ready
  if (lifecycle.phase !== 'running') {
    throw new Error(`desktop recording: Host did not reach the running phase (${lifecycle.phase})`)
  }
  const recorder = createFrameRecorder(window, framesDir)
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
    await recorder.capture('launch')
    await completeOnboarding(window)

    const blurred = onceWindowEvent(window, 'blur')
    other = new BrowserWindow({ width: 240, height: 160, show: true })
    other.focus()
    await blurred
    await recorder.capture('inactive')
    const focused = onceWindowEvent(window, 'focus')
    window.focus()
    await focused
    await recorder.capture('active')

    // Synthetic input exercises the drag strip without OS-level pointer
    // permissions; the evidence line records the resulting bounds.
    window.webContents.sendInputEvent({ type: 'mouseDown', x: 480, y: 20, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 520, y: 60, movementX: 40, movementY: 40 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 520, y: 60, button: 'left', clickCount: 1 })
    const dragAttemptBounds = window.getBounds()
    await recorder.capture('drag-strip-attempt')

    const sessionId = await reachLiveComposer(currentSupervisor(lifecycle), window)
    const keyboard = await typeIntoComposer(window)
    const controlBounds = window.getBounds()
    await recorder.capture('keyboard-typed')

    const minimized = onceWindowEvent(window, 'minimize')
    window.minimize()
    await minimized
    const wasMinimized = window.isMinimized()
    const restored = onceWindowEvent(window, 'restore')
    window.restore()
    await restored
    await recorder.capture('restored')

    nativeTheme.themeSource = 'dark'
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    await recorder.capture('appearance-dark')
    nativeTheme.themeSource = 'light'
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
    await recorder.capture('appearance-light')

    // The tracer bullet: replay the recorded turn through the assembled
    // renderer while polling frames, so the frames show the real session and
    // streamed transcript rather than a synthetic page.
    const poll = (async () => {
      while (capturing) {
        await recorder.capture('tracer-turn')
        await new Promise(resolveWait => setTimeout(resolveWait, 400))
      }
    })()
    try {
      console.log('SMOKE_OK session')
      await submitRecordedPrompt(window)
      await waitForRecordedTurn(currentSupervisor(lifecycle), window, sessionId)
    } catch (error) {
      scenarioFailure = error instanceof Error ? error.message : String(error)
    } finally {
      capturing = false
    }
    await poll
    await recorder.capture('tracer-settled')

    console.log(`NATIVE_WINDOW_RECORDING ${JSON.stringify({
      framesDir,
      frames: recorder.frames,
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
    await stopAfterJourney(lifecycle, true)
  }
  console.log('SMOKE_OK quit')
}

/**
 * Record the recovery journey: a configuration failure reaches the visible
 * failed state, one controlled restart returns the Host to the running phase,
 * and the real Session surface becomes usable again. Requires
 * `--record-recovery --smoke-replay <file>` plus an explicit
 * `DSH_DESKTOP_FRAMES_DIR` and `DSH_HOME`; the caller must have seeded the
 * broken profile ({@link prepareBrokenProfile}) before the Host spawned.
 */
async function recordRecovery(
  lifecycle: DesktopLifecycle,
  replayFile: string,
  replayProvider: string,
): Promise<void> {
  const framesDir = process.env.DSH_DESKTOP_FRAMES_DIR
  if (framesDir === undefined || framesDir.trim() === '') {
    throw new Error('desktop recovery recording requires DSH_DESKTOP_FRAMES_DIR so frames never touch the owner\'s home')
  }
  await mkdir(framesDir, { recursive: true })
  const { window, ready } = bootWindow(lifecycle)
  const recorder = createFrameRecorder(window, framesDir)
  const phases: HostPhase[] = []
  lifecycle.onPhase((phase) => { phases.push(phase) })
  window.show()
  window.focus()

  let scenarioFailure: string | null = null
  try {
    // Startup failure: the seeded broken profile must land the visible
    // failed state (configuration failure), not a hang or a silent blank.
    await ready
    if (lifecycle.phase !== 'failed' || lifecycle.failure === undefined) {
      throw new Error(`desktop recovery: expected the failed phase, reached ${lifecycle.phase}`)
    }
    // Restart clears lifecycle.failure once the fresh generation becomes
    // ready, so retain the startup failure for the recording verdict.
    const startupFailure = lifecycle.failure
    await waitForRenderer(window, 'document.querySelector("#restart") !== null', 5_000)
    await recorder.capture('startup-failed')
    console.log('SMOKE_OK recovery-failed-state')

    // One controlled restart after repairing the configuration.
    prepareSmokeProfile(replayFile, replayProvider)
    const restarting = lifecycle.restart()
    await waitForRenderer(window, 'document.getElementById("message")?.textContent?.includes("Starting")', 5_000)
    await recorder.capture('restarting')
    await restarting
    // The phase may have advanced while restart() ran; avoid narrowing on the
    // pre-restart snapshot so the running check stays live.
    const settledPhase = lifecycle.phase as HostPhase
    if (settledPhase !== 'running') {
      throw new Error(`desktop recovery: restart did not reach the running phase (${settledPhase})`)
    }
    console.log('SMOKE_OK recovery-restart')

    // Return to a usable Session state over the fresh generation.
    await waitForRenderer(window, "document.querySelector('#root > *') && document.querySelector('textarea')")
    await completeOnboarding(window)
    const sessionId = await reachLiveComposer(currentSupervisor(lifecycle), window)
    const keyboard = await typeIntoComposer(window)
    await recorder.capture('session-recovered')
    console.log('SMOKE_OK session')

    try {
      await submitRecordedPrompt(window)
      await waitForRecordedTurn(currentSupervisor(lifecycle), window, sessionId)
    } catch (error) {
      scenarioFailure = error instanceof Error ? error.message : String(error)
    }
    await recorder.capture('tracer-settled')

    console.log(`RECOVERY_RECORDING ${JSON.stringify({
      framesDir,
      frames: recorder.frames,
      phases,
      failure: {
        kind: startupFailure.kind,
        message: startupFailure.message,
        detail: startupFailure.detail ?? null,
      },
      keyboard,
      scenarioFailure,
    })}`)
  } finally {
    window.destroy()
    await stopAfterJourney(lifecycle, true)
  }
  console.log('SMOKE_OK quit')
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
async function bootSmoke(lifecycle: DesktopLifecycle): Promise<number> {
  try {
    await lifecycle.start()
    if (lifecycle.phase !== 'running') {
      throw new Error(`desktop smoke: Host did not reach the running phase (${lifecycle.phase})`)
    }
    const current = lifecycle.current()
    if (current === undefined) throw new Error('desktop smoke: no DSH generation after start')
    await runSmokeScenario(current.supervisor, current.childPid ?? process.pid)
    const report = await lifecycle.stop()
    if (!report.quiescent) {
      console.error(`SMOKE_QUIT_FAILED ${JSON.stringify(report.failure)}`)
      return 1
    }
    console.log('SMOKE_OK quit')
    console.log('SMOKE_PASS')
    return 0
  } catch (error) {
    console.error(`desktop smoke failed: ${error instanceof Error ? error.message : String(error)}`)
    // A stop failure is secondary to the scenario verdict already in hand, so
    // report it by name instead of masking the original error.
    const report = await lifecycle.stop()
    if (!report.quiescent) {
      console.error(`SMOKE_QUIT_FAILED ${JSON.stringify(report.failure)}`)
    }
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
    const recoveryRecording = process.argv.includes('--record-recovery')
    const smoke = parseSmokeInvocation(process.argv)
    const options = app.isPackaged
      ? packagedChildOptions(smoke !== undefined || recording || recoveryRecording)
      : developmentChildOptions()
    const lifecycle = new DesktopLifecycle({
      spawn: () => spawnDshChild(options),
    })
    lifecycle.onPhase((phase) => { console.error(`[desktop-main] Host phase: ${phase}`) })
    const webDist = app.isPackaged
      ? packagedRuntimeLayout(process.resourcesPath, app.getPath('userData')).webDist
      : resolve(packageDir('@deepseek-ai/dsh-web-frontend'), 'dist')
    registerAssetProtocol(webDist)
    const headless = smoke !== undefined || acceptance || recording || recoveryRecording
    installQuitOwner(lifecycle, () => currentWindow, headless)

    if (recording || recoveryRecording) {
      const replayFile = parseReplayArg(process.argv)
      if (replayFile === undefined) {
        console.error('desktop recording requires --smoke-replay <file>')
        app.exit(1)
        return
      }
      // The child reads its profile at boot, so the smoke profile (bundles +
      // keyless replay patch + the fallback link to the replay provider) must
      // exist before the child spawns.
      const replayProvider = app.isPackaged
        ? packagedRuntimeLayout(process.resourcesPath, app.getPath('userData')).replayProvider
        : packageDir('@deepseek-ai/dsh-llm-replay')
      if (recording) prepareSmokeProfile(replayFile, replayProvider)
      else prepareBrokenProfile()
      try {
        if (recording) await recordNativeWindow(lifecycle)
        else await recordRecovery(lifecycle, replayFile, replayProvider)
      } catch (error) {
        console.error(`desktop recording failed: ${error instanceof Error ? error.message : String(error)}`)
        await lifecycle.stop().catch((stopError: unknown) => {
          // The recording verdict above already owns this failure mode;
          // report shutdown trouble without replacing it.
          console.error('desktop recording failed to stop after failure:', stopError)
        })
        app.exit(1)
        return
      }
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
      app.exit(await bootSmoke(lifecycle))
      return
    }
    if (acceptance) {
      try {
        await acceptNativeWindow(lifecycle)
      } catch (error) {
        console.error(`desktop acceptance failed: ${error instanceof Error ? error.message : String(error)}`)
        await lifecycle.stop().catch((stopError: unknown) => {
          // The acceptance verdict above already owns this failure mode;
          // report shutdown trouble without replacing it.
          console.error('desktop acceptance failed to stop after failure:', stopError)
        })
        app.exit(1)
        return
      }
      app.exit(0)
      return
    }
    // Interactive: the window shows the starting status page while the Host
    // boots; startup failure reaches the visible failed state with restart.
    bootWindow(lifecycle)
  })().catch((error: unknown) => {
    console.error(`desktop app failed to start: ${String(error)}`)
    app.exit(1)
  })
})
