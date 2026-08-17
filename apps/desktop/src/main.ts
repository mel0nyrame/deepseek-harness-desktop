/** Electron desktop entry: development shell and packaged application. */

import { fork } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell,
  type IpcMainEvent, type IpcMainInvokeEvent,
} from 'electron'
import { DshSupervisor } from './supervisor.ts'
import { DesktopLifecycle, type HostPhase, type StopReport } from './lifecycle.ts'
import { createProcessTreeLadder } from './process-tree.ts'
import { DESKTOP_STATUS_HTML, STATUS_PAGE_PATH, statusStateFor } from './status.ts'
import { RendererStreamRelay } from './renderer-stream-relay.ts'
import {
  desktopRpc,
  discoverAcceptanceSession,
  discoverAcceptanceWorkspaceSession,
} from './acceptance.ts'
import {
  PACKAGED_CHILD_EXEC_ARGV,
  packagedChildEnv,
  packagedRuntimeLayout,
  parseSidebarGlassAcceptanceInvocation,
  parseSmokeInvocation,
  parseSmokeReopenInvocation,
} from './packaged-runtime.ts'
import {
  APPROVAL_FILE, APPROVAL_PROMPT, prepareBrokenProfile, prepareSmokeProfile, QUESTION_ANSWER,
  QUESTION_PROMPT, RECORDED_PROMPT, runSmokeReopen, runSmokeScenario, toolResultText,
} from './smoke.ts'
import { DESKTOP_SURFACE_CSS, desktopWindowOptions, rendererSurfaceState } from './native-window.ts'
import { createNativeActionHandler, type DesktopNativePlatform } from './native-actions.ts'
import { acceptSidebarGlass } from './sidebar-glass-acceptance.ts'
import {
  isDesktopAppUrl,
  parseRendererId,
  parseRendererRecoveryAction,
  parseRendererRequest,
  parseRendererSubscription,
  parseRendererThemePreference,
  toRendererStreamEvent,
} from './renderer-ipc.ts'

const SCHEME = 'dsh'
const APP_ORIGIN = `${SCHEME}://app`
const require = createRequire(import.meta.url)

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

// Evidence journeys must render identically on every host. CI macOS runners
// expose no reliable GPU: a transient command-buffer failure wedges the
// renderer's script channel, hanging the journeys' executeJavaScript waits
// (observed on the Intel matrix runner, where the same launch can paint or
// hang). Software rendering keeps every journey paint and capturePage frame
// deterministic, so every journey mode disables hardware acceleration before
// ready; the interactive product launch keeps it.
const JOURNEY_FLAGS = [
  '--inspect-native-window',
  '--accept-native-window',
  '--accept-native-window-drag',
  '--accept-sidebar-glass',
  '--record-native-window',
  '--record-native-actions',
  '--record-recovery',
  '--smoke',
  '--smoke-reopen',
] as const
if (JOURNEY_FLAGS.some(flag => process.argv.includes(flag))) {
  app.disableHardwareAcceleration()
}

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

/** True while one absolute target exists for the operating-system handoff. */
async function statAvailable(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (_error: unknown) {
    // Missing, unreadable, and broken-link targets are all unavailable to
    // the operating-system handoff and share one actionable result.
    return false
  }
}

/** Bind the production native-action boundary to Electron main primitives. */
function electronNativePlatform(window: BrowserWindow): DesktopNativePlatform {
  return {
    async pickDirectory() {
      const result = await dialog.showOpenDialog(window, {
        title: '选择工作区文件夹',
        buttonLabel: '选择文件夹',
        properties: ['openDirectory', 'createDirectory'],
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    pathAvailable: statAvailable,
    openPath: path => shell.openPath(path),
    async reportFailure(path, message) {
      if (window.isDestroyed()) return
      await dialog.showMessageBox(window, {
        type: 'error',
        message: '无法打开路径',
        detail: `${path}\n\n${message}`,
        buttons: ['好'],
      })
    },
  }
}

function installIpc(
  window: BrowserWindow,
  lifecycle: DesktopLifecycle,
  nativePlatform: DesktopNativePlatform = electronNativePlatform(window),
): () => void {
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
  const handleNativeAction = createNativeActionHandler(nativePlatform)
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
    maybeSupervisor()?.subscribe(subscription.id, subscription.stream, { relayed: true })
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
    // The preload acknowledgement completes the renderer round-trip; forward
    // it to the child so its pump may send the next frame.
    maybeSupervisor()?.ackStream(id)
  })
  ipcMain.on('dsh:set-theme-preference', (event, value: unknown) => {
    if (!senderAllowed(event)) return
    const preference = parseRendererThemePreference(value)
    if (preference === undefined) {
      console.error('[desktop-main] dropped malformed theme preference')
      return
    }
    nativeTheme.themeSource = preference
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
  let stopNativeActions = (): void => {}
  let nativeActionSupervisor: DshSupervisor | undefined
  const attachStreams = (): void => {
    stopStreams()
    const current = lifecycle.current()
    if (current !== undefined) {
      stopStreams = current.supervisor.onStream((message) => {
        relay.push(toRendererStreamEvent(message))
      })
    }
    if (current?.supervisor === nativeActionSupervisor) return
    stopNativeActions()
    nativeActionSupervisor = current?.supervisor
    stopNativeActions = current === undefined
      ? () => {}
      : current.supervisor.serveNativeActions(handleNativeAction)
  }
  const detachPhase = lifecycle.onPhase(attachStreams)
  attachStreams()
  return () => {
    detachPhase()
    stopStreams()
    stopNativeActions()
    nativeActionSupervisor = undefined
    relay.clearAll()
    if (!webContents.isDestroyed()) {
      webContents.off('render-process-gone', disconnectRenderer)
      webContents.off('destroyed', disconnectRenderer)
      webContents.off('did-navigate', onNavigation)
    }
    ipcMain.removeHandler('dsh:request')
    ipcMain.removeHandler('dsh:recovery')
    for (const channel of ['dsh:boot', 'dsh:cancel-request', 'dsh:subscribe', 'dsh:cancel-subscription', 'dsh:stream-ack', 'dsh:set-theme-preference']) {
      ipcMain.removeAllListeners(channel)
    }
  }
}

/** Push the current native appearance, platform, and full-screen facts into the renderer. */
function applyRendererNativeState(window: BrowserWindow): Promise<void> {
  const state = rendererSurfaceState(
    nativeTheme.shouldUseDarkColors,
    nativeTheme.prefersReducedTransparency,
    process.platform,
  )
  const surface = window.webContents.executeJavaScript(`
    document.body.dataset.dshAppearance = ${JSON.stringify(state.appearance)};
    document.body.dataset.dshTransparency = ${JSON.stringify(state.transparency)};
    document.body.dataset.dshPlatform = ${JSON.stringify(state.platform)};
    document.body.dataset.dshFullscreen = ${JSON.stringify(window.isFullScreen())};
  `).then(() => undefined, (error: unknown) => {
    console.error(`desktop renderer boot state update failed: ${String(error)}`)
  })
  return surface
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
    await applyRendererNativeState(window)
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
  nativePlatform?: DesktopNativePlatform,
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
  const applyRendererState = (): void => { void applyRendererNativeState(window) }
  applyRendererState()
  nativeTheme.on('updated', applyRendererState)
  window.on('enter-full-screen', applyRendererState)
  window.on('leave-full-screen', applyRendererState)
  window.once('closed', () => {
    if (currentWindow === window) currentWindow = undefined
    nativeTheme.off('updated', applyRendererState)
    window.removeListener('enter-full-screen', applyRendererState)
    window.removeListener('leave-full-screen', applyRendererState)
  })
  app.on('window-all-closed', () => { app.quit() })

  const removeIpc = installIpc(window, lifecycle, nativePlatform)
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

function onceWindowEvent(
  window: BrowserWindow,
  event: 'focus' | 'blur' | 'minimize' | 'restore' | 'enter-full-screen' | 'leave-full-screen',
): Promise<void> {
  return new Promise((resolveEvent) => {
    const done = (): void => { resolveEvent() }
    switch (event) {
      case 'focus': window.once('focus', done); break
      case 'blur': window.once('blur', done); break
      case 'minimize': window.once('minimize', done); break
      case 'restore': window.once('restore', done); break
      case 'enter-full-screen': window.once('enter-full-screen', done); break
      case 'leave-full-screen': window.once('leave-full-screen', done); break
    }
  })
}

/** Enter and leave native full screen, re-syncing renderer state at each edge. */
async function exerciseFullscreen(window: BrowserWindow, during?: () => Promise<void>): Promise<void> {
  const entered = onceWindowEvent(window, 'enter-full-screen')
  window.setFullScreen(true)
  await entered
  await applyRendererNativeState(window)
  await during?.()
  const left = onceWindowEvent(window, 'leave-full-screen')
  window.setFullScreen(false)
  await left
  await applyRendererNativeState(window)
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

/** Drag the sidebar resize handle with real pointer input to a new edge x. */
async function dragSidebarHandle(window: BrowserWindow, toX: number): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const handle = document.querySelector('[data-side="sidebar"]');
    if (handle === null) return null;
    const box = handle.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  })()`) as { x: number; y: number } | null
  if (point === null) {
    const state = await window.webContents.executeJavaScript(`(() => {
      const frame = document.querySelector('[data-side="sidebar"]')?.parentElement;
      return {
        innerWidth,
        collapsed: document.querySelector('[data-sidebar-collapsed]') !== null,
        reveal: document.querySelector('[data-sidebar-reveal]') !== null,
        toggle: document.querySelector('[data-sidebar-toggle]') !== null,
        sides: Array.from(document.querySelectorAll('[data-side]')).map(el => el.getAttribute('data-side')),
        frameTemplate: frame === null ? null : getComputedStyle(frame).gridTemplateColumns,
        frameAttrs: frame === null ? null : frame.getAttributeNames(),
      };
    })()`) as unknown
    throw new Error(`desktop acceptance: sidebar resize handle is not rendered; frame state: ${JSON.stringify(state)}`)
  }
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    x: toX,
    y: point.y,
    movementX: toX - point.x,
    movementY: 0,
    modifiers: ['leftbuttondown'],
  })
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  window.webContents.sendInputEvent({ type: 'mouseUp', x: toX, y: point.y, button: 'left', clickCount: 1 })
  await new Promise(resolveWait => setTimeout(resolveWait, 150))
  const landed = await window.webContents.executeJavaScript(`(() => {
    const handle = document.querySelector('[data-side="sidebar"]');
    const frame = document.querySelector('[data-side="sidebar"]')?.parentElement;
    return {
      handleLeft: handle === null ? null : handle.style.left,
      frameTemplate: frame === null ? null : getComputedStyle(frame).gridTemplateColumns,
      active: document.activeElement?.tagName,
    };
  })()`) as unknown
  if (typeof landed === 'object' && landed !== null
    && (landed as Record<string, unknown>)['handleLeft'] !== `${toX}px`) {
    throw new Error(`desktop acceptance: sidebar drag did not land on ${toX}px: ${JSON.stringify(landed)}`)
  }
}

/** Measure the collapsed-sidebar contract: zero-width track, reveal control
 * position, conversation-header clearance, and the reclaimed conversation
 * surface (issue #33). */
function collapsedSidebarGeometry(window: BrowserWindow): Promise<unknown> {
  return window.webContents.executeJavaScript(`(() => {
    const frame = document.querySelector('[data-sidebar-collapsed]');
    const reveal = document.querySelector('[data-sidebar-reveal]');
    const headers = Array.from(document.querySelectorAll('[data-conversation-header]'));
    const header = headers
      .find(candidate => candidate.getClientRects().length > 0 && candidate.getAttribute('aria-hidden') !== 'true')
      ?? headers[0]
      ?? null;
    const conversation = document.querySelector('[data-center-column]');
    const track = frame === null ? null : getComputedStyle(frame).gridTemplateColumns;
    return {
      track,
      reveal: reveal === null ? null : reveal.getBoundingClientRect().toJSON(),
      headerPaddingLeft: header === null ? null : getComputedStyle(header).paddingLeft,
      headerPaddingTop: header === null ? null : getComputedStyle(header).paddingTop,
      header: header === null ? null : header.getBoundingClientRect().toJSON(),
      title: header?.querySelector('nav')?.getBoundingClientRect().toJSON() ?? null,
      tabs: header?.querySelector('[role="tablist"]')?.getBoundingClientRect().toJSON() ?? null,
      conversation: conversation === null
        ? null
        : { ...conversation.getBoundingClientRect().toJSON(), viewport: innerWidth },
    };
  })()`)
}

type AcceptanceRpcResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Send one acceptance request through the real context-isolated renderer bridge. */
async function rendererRpc(
  window: BrowserWindow,
  id: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<AcceptanceRpcResult> {
  const request = {
    id,
    url: `dsh://app/api/${method}`,
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
  }
  const parsed = await window.webContents.executeJavaScript(`globalThis.dshDesktop
    .request(${JSON.stringify(request)})
    .then(response => JSON.parse(response.body))`) as unknown
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`desktop acceptance: ${method} returned no server response`)
  }
  const envelope = parsed as { type?: unknown; result?: unknown }
  if (envelope.type !== 'server-response' || typeof envelope.result !== 'object' || envelope.result === null) {
    throw new Error(`desktop acceptance: ${method} returned a malformed server response`)
  }
  const result = envelope.result as { ok?: unknown; value?: unknown; error?: unknown }
  if (result.ok === true && typeof result.value === 'object' && result.value !== null) {
    return { ok: true, value: result.value as Record<string, unknown> }
  }
  if (result.ok === false && typeof result.error === 'object' && result.error !== null) {
    const error = result.error as { code?: unknown; message?: unknown }
    if (typeof error.code === 'string' && typeof error.message === 'string') {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
  }
  throw new Error(`desktop acceptance: ${method} returned a malformed result`)
}

const LIVE_COMPOSER = 'textarea:not([readonly]):not(:disabled)'
const SETTLED_BASH_CARD = '[data-sample="bash"][data-state="ok"]'

/** Pass the product's two named first-run gates through real pointer controls. */
async function completeOnboarding(window: BrowserWindow): Promise<void> {
  const dialog = '[role="dialog"]'
  const title = `${dialog} h2`
  try {
    // The welcome notice needs a settings round trip through the desktop
    // wire; the first boot can take a while on a busy machine.
    await waitForRenderer(window, `document.querySelector(${JSON.stringify(title)})?.textContent?.trim() === 'Internal Testing Notice'`, 60_000)
  } catch (error) {
    const state = await window.webContents.executeJavaScript(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].map(dialogEl => ({
        h2: dialogEl.querySelector('h2')?.textContent?.trim() ?? null,
        heading: dialogEl.querySelector('h1, h2, h3')?.textContent?.trim() ?? null,
      }));
      return {
        dialogs,
        innerWidth,
        assembled: document.querySelector('#root > *') !== null,
        bodyPrefix: document.body?.textContent?.trim().slice(0, 160) ?? null,
      };
    })()`).catch(() => null) as unknown
    throw new Error(`${String(error)}; page state: ${JSON.stringify(state)}`)
  }
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
 * @returns the opened session plus the workspace id the acceptance run adopted.
 */
async function reachLiveComposer(
  supervisor: DshSupervisor,
  window: BrowserWindow,
): Promise<{ sessionId: string; workspaceId: string }> {
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
  await applyRendererNativeState(window)
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
  const sessionId = await discoverAcceptanceSession(supervisor, workspaceId)
  return { sessionId, workspaceId }
}

/** Adopt a fresh Workspace through the real native-picker UI and open its Session. */
async function reachLiveComposerThroughNativePicker(
  supervisor: DshSupervisor,
  window: BrowserWindow,
  canonicalWorkspacePath: string,
  nativePickStarted: () => boolean,
): Promise<{ workspaceId: string; sessionId: string; visible: boolean }> {
  await waitForRenderer(window, "document.querySelector('#root > *') && document.querySelector('textarea')")
  await completeOnboarding(window)
  await waitForRenderer(window, "document.querySelector('textarea[aria-haspopup]') && !document.querySelector('textarea').disabled")
  for (let attempt = 0; attempt < 10 && !nativePickStarted(); attempt += 1) {
    await clickAt(window, '[data-composer-card]')
    try {
      await waitForRenderer(window, "document.querySelector('textarea[aria-expanded=\"true\"]')", 1_000)
      break
    } catch (error) {
      if (nativePickStarted()) break
      if (attempt === 9) throw error
    }
  }
  const adopted = await discoverAcceptanceWorkspaceSession(supervisor, canonicalWorkspacePath)
  await waitForRenderer(window, `document.querySelector(${JSON.stringify(LIVE_COMPOSER)})`)
  const visible = await window.webContents.executeJavaScript(
    `document.body.textContent?.includes(${JSON.stringify(basename(canonicalWorkspacePath))}) === true`,
  ) as boolean
  return { ...adopted, visible }
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

/**
 * Replace the live draft and submit it through the renderer's real Enter path.
 * A takeover prompt (question or approval) replaces the composer instead of
 * clearing it, so the settle check accepts the takeover surface too.
 * @param window - the assembled renderer window.
 * @param prompt - the exact prompt text to submit.
 * @param takeover - whether the prompt takes the composer over (question/approval).
 */
async function submitRecordedPrompt(window: BrowserWindow, prompt: string, takeover = false): Promise<void> {
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
    await window.webContents.insertText(prompt)
    try {
      await waitForRenderer(
        window,
        `document.querySelector(${JSON.stringify(LIVE_COMPOSER)})?.value === ${JSON.stringify(prompt)}`,
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
  const cleared = `document.querySelector(${JSON.stringify(LIVE_COMPOSER)})?.value === ''`
  const expectation = takeover
    ? `(${cleared}) || Boolean(document.querySelector('[data-question-key], [data-approval-key]'))`
    : cleared
  await waitForRenderer(window, expectation)
}

interface RecordedHistoryEvent {
  readonly type: string
  readonly data?: unknown
}

/** One replayed turn's settlement contract: tool, tool output, and renderer surface. */
interface TurnExpectation {
  /** The tool the replayed turn must call at least once. */
  readonly toolName: string
  /** Required substring in the turn's tool-result text (when set). */
  readonly toolResultContains?: string
  /** DOM selector that must exist once the turn settles. */
  readonly settledSelector?: string
  /** DOM selector that must be gone once the turn settles. */
  readonly goneSelector?: string
}

/**
 * Verify one replayed turn through durable history and the rendered surface.
 * The turn must end cleanly (a `turn/end` whose reason is `completed`): a
 * replay underrun — an auxiliary call stealing the session's replay cursor,
 * for example — surfaces as an errored turn and fails here instead of
 * passing silently.
 * @returns the turn's history events.
 */
async function waitForTurnCompleted(
  supervisor: DshSupervisor,
  window: BrowserWindow,
  sessionId: string,
  expectation: TurnExpectation,
): Promise<RecordedHistoryEvent[]> {
  const deadline = Date.now() + 120_000
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
    const turnEnd = events.findLast(event => event.type === 'turn/end')
    const reason = (turnEnd?.data as { reason?: { kind?: unknown } } | undefined)?.reason
    const settledDom = expectation.settledSelector === undefined
      || await window.webContents.executeJavaScript(
        `Boolean(document.querySelector(${JSON.stringify(expectation.settledSelector)}))`,
      ) as boolean
    const goneDom = expectation.goneSelector === undefined
      || !(await window.webContents.executeJavaScript(
        `Boolean(document.querySelector(${JSON.stringify(expectation.goneSelector)}))`,
      ) as boolean)
    if (hasToolResult && reason?.kind === 'completed' && settledDom && goneDom) break
    if (Date.now() > deadline) {
      throw new Error(`desktop recording scenario did not settle; events: ${JSON.stringify(events).slice(0, 4000)}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  if (!events.some(event => event.type === 'tool/call'
    && (event.data as { name?: unknown } | undefined)?.name === expectation.toolName)) {
    throw new Error(`desktop recording: the replayed turn did not call ${expectation.toolName}`)
  }
  if (expectation.toolResultContains !== undefined) {
    const resultText = toolResultText(events)
    if (!resultText.includes(expectation.toolResultContains)) {
      throw new Error(
        `desktop recording: the tool result did not contain ${expectation.toolResultContains}; actual: ${JSON.stringify(resultText)}`,
      )
    }
  }
  return events
}

/** Measured center of the first element a finder expression selects, or null. */
async function matchingPoint(
  window: BrowserWindow,
  finder: string,
): Promise<{ x: number; y: number } | null> {
  return await window.webContents.executeJavaScript(`(() => {
    const el = (${finder});
    if (el === null || el === undefined) return null;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  })()`) as { x: number; y: number } | null
}

/** Click one measured point with real pointer input. */
function clickPoint(window: BrowserWindow, point: { x: number; y: number }): void {
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
}

/** Wait for the element a finder expression selects, then click it with real pointer input. */
async function clickMatching(window: BrowserWindow, finder: string, description: string): Promise<void> {
  await waitForRenderer(window, `(${finder}) !== null`, 60_000)
  const point = await matchingPoint(window, finder)
  if (point === null) throw new Error(`desktop recording: ${description} has no clickable element`)
  clickPoint(window, point)
}

/**
 * Start a new blank session through the product's own New session action (the
 * sidebar header button), then discover the id the product minted. The
 * desktop window boots with the workspace sidebar collapsed, so the journey
 * opens it through its real toggle first. The minted session becomes the
 * product's current session, so the composer lands on it directly — no row
 * click, and no race with the client's own mint.
 */
async function startSessionThroughProduct(
  supervisor: DshSupervisor,
  window: BrowserWindow,
  workspaceId: string,
  rpcId: string,
): Promise<string> {
  const before = await workspaceSessionIds(supervisor, workspaceId)
  if (await window.webContents.executeJavaScript(
    'document.querySelector(\'[aria-label="Open sidebar"]\') !== null',
  ) as boolean) {
    await clickAt(window, '[aria-label="Open sidebar"]')
  }
  // The sidebar's own New session action (its header button) mints the
  // session through the shared startSession flow: it resolves the current
  // session's Workspace, reuses or creates its blank session, and navigates
  // there — the same gesture a desktop user makes.
  await waitForRenderer(window, 'document.querySelector(\'[aria-label="New session"]\') !== null', 15_000)
  // The sidebar header button sits in a clipped hover-reveal strip where
  // synthetic pointer hit-testing is unreliable; the element's own click
  // event runs the product's real handler (startSession) and navigation —
  // the same gesture fidelity the Web question test uses for its answer.
  const clicked = await window.webContents.executeJavaScript(
    "(() => { const el = document.querySelector('[aria-label=\\\"New session\\\"]'); if (el === null) return false; el.click(); return true })()",
  ) as boolean
  if (!clicked) throw new Error('desktop recording: the New session action never appeared')
  await waitForRenderer(window, `Boolean(document.querySelector(${JSON.stringify(LIVE_COMPOSER)}))`, 15_000)
  const deadline = Date.now() + 15_000
  for (;;) {
    const after = await workspaceSessionIds(supervisor, workspaceId)
    const added = after.filter(id => !before.includes(id))
    if (added.length > 1) {
      throw new Error(`desktop recording: the New session action minted ${String(added.length)} sessions`)
    }
    if (added.length === 1) return added[0] as string
    if (Date.now() > deadline) {
      throw new Error(
        `desktop recording: the New session action minted no discoverable session (${rpcId}); before: ${JSON.stringify(before)} after: ${JSON.stringify(after)}`,
      )
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
}

/** The acceptance workspace's accounted session ids, in list order. */
async function workspaceSessionIds(supervisor: DshSupervisor, workspaceId: string): Promise<string[]> {
  const listed = await desktopRpc(supervisor, `record-workspace-${workspaceId}-${Math.random()}`, 'workspace.list', {})
  const items = listed['items'] as Array<Record<string, unknown>>
  const workspace = items.find(item => item['workspaceId'] === workspaceId)
  const sessionIds = workspace?.['sessionIds']
  if (!Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string')) {
    throw new Error('desktop recording: workspace.list returned no session ids for the acceptance workspace')
  }
  return sessionIds as string[]
}

/** Switch the active session to Read Only through the shipped access-mode chip. */
async function switchAccessModeReadOnly(window: BrowserWindow): Promise<void> {
  await clickAt(window, '[aria-label^="Access mode"]')
  await clickMatching(
    window,
    "[...document.querySelectorAll('[role=\"menuitem\"]')]"
      + ".find(candidate => candidate.textContent?.trim() === 'Read Only') ?? null",
    'the Read Only menu item',
  )
  await waitForRenderer(window, "document.querySelector('[aria-label=\"Access mode, current: Read Only\"]') !== null", 15_000)
}

/** Answer the assembled question composer: Blue plus custom text, submitted with Enter. */
async function answerQuestionComposer(window: BrowserWindow): Promise<void> {
  await clickMatching(
    window,
    "document.querySelector('[data-question-key]') === null ? null : "
      + "[...document.querySelector('[data-question-key]').querySelectorAll('[role=\"checkbox\"], [role=\"radio\"]')]"
      + ".find(candidate => candidate.textContent?.includes('Blue') === true) ?? null",
    'the Blue option',
  )
  await waitForRenderer(window, "(() => { const composer = document.querySelector('[data-question-key]'); "
    + "const option = composer === null ? undefined : [...composer.querySelectorAll('[role=\"checkbox\"]')]"
    + ".find(candidate => candidate.textContent?.includes('Blue') === true); "
    + "return option?.getAttribute('aria-checked') === 'true' })()", 5_000)
  await clickMatching(
    window,
    "document.querySelector('[data-question-key]') === null ? null : "
      + "document.querySelector('[data-question-key] input:not([type=\"checkbox\"]), [data-question-key] textarea, [data-question-key] [role=\"textbox\"]')",
    'the custom answer textbox',
  )
  // Synthetic pointer input does not move focus into the takeover textbox, so
  // the custom text is filled through the element's own input event (the same
  // gesture the Web question test performs with Playwright's fill), then the
  // answer is submitted through the real Enter key path.
  const filled = await window.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-question-key] input:not([type="checkbox"]), [data-question-key] textarea, [data-question-key] [role="textbox"]');
    if (el === null) return false;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, 'Include accessibility notes');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === 'Include accessibility notes';
  })()`) as boolean
  if (!filled) throw new Error('desktop recording: the custom answer text did not land in the textbox')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
}

/** Click Allow once in the assembled approval panel. */
async function allowApprovalOnce(window: BrowserWindow): Promise<void> {
  await clickMatching(
    window,
    "document.querySelector('[data-approval-key]') === null ? null : "
      + "[...document.querySelector('[data-approval-key]').querySelectorAll('button')]"
      + ".find(candidate => candidate.textContent?.trim() === 'Allow once') ?? null",
    'the Allow once button',
  )
}

/** Exercise the installed app's assembled renderer and visible native window. */
async function acceptNativeWindow(lifecycle: DesktopLifecycle): Promise<void> {
  const { window, ready } = bootWindow(lifecycle)
  await ready
  if (lifecycle.phase !== 'running') {
    throw new Error(`desktop acceptance: Host did not reach the running phase (${lifecycle.phase})`)
  }
  const focus: string[] = []
  // Keep the window above SIDEBAR_AUTO_COLLAPSE (1024px). Work-area clamping
  // can narrow it again, so the phase re-expands the sidebar before dragging
  // when necessary.
  window.setBounds({ x: 120, y: 120, width: 1160, height: 700 })
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

    // The baseline for the no-move claim is the bounds macOS granted at
    // launch, not the requested rect: displays shorter than the request (the
    // CI arm64 runner's work area) clamp it, and the granted bounds are the
    // truthful starting position the drag attempt must leave untouched.
    const initialBounds = window.getBounds()
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

    const rowGeometry = (): string => `(() => {
      const control = document.querySelector('[data-sidebar-control-row]');
      const brand = document.querySelector('[data-sidebar-brand-row]');
      return {
        controlRowPaddingLeft: control === null ? null : getComputedStyle(control).paddingLeft,
        brandRowPaddingLeft: brand === null ? null : getComputedStyle(brand).paddingLeft,
        controlRowTop: control === null ? null : control.getBoundingClientRect().top,
        brandRowTop: brand === null ? null : brand.getBoundingClientRect().top,
      };
    })()`
    const fullscreenBefore = await window.webContents.executeJavaScript(rowGeometry()) as unknown
    let fullscreen: unknown
    await exerciseFullscreen(window, async () => {
      fullscreen = await window.webContents.executeJavaScript(`(() => {
        const geometry = ${rowGeometry()};
        return { active: document.body.dataset.dshFullscreen, ...geometry };
      })()`) as unknown
    })
    const fullscreenAfter = await window.webContents.executeJavaScript(
      'document.body.dataset.dshFullscreen',
    ) as unknown

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
        dragRegion: getComputedStyle(document.querySelector('[data-conversation-header]')).webkitAppRegion,
        controlRegion: getComputedStyle(textarea).webkitAppRegion,
        activeElement: document.activeElement?.tagName,
        keyboardValue: textarea.value,
      };
    })()`) as unknown

    // The collapsed sidebar must leave a zero-width track, give the
    // conversation the reclaimed width, clear native traffic lights in a
    // window, move to the content inset in full screen, and restore the exact
    // user width after reveal.
    // Work-area clamping may auto-collapse after setBounds; expand before drag.
    window.setBounds({ x: 120, y: 120, width: 1160, height: 700 })
    await new Promise(resolveWait => setTimeout(resolveWait, 300))
    if (await window.webContents.executeJavaScript("document.querySelector('[data-sidebar-reveal]') !== null")) {
      await clickAt(window, '[data-sidebar-reveal]')
      await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') === null")
    }
    await dragSidebarHandle(window, 350)
    await waitForRenderer(window, "getComputedStyle(document.querySelector('[data-side=\"sidebar\"]')?.parentElement).gridTemplateColumns.startsWith('350px')")
    await clickAt(window, '[data-sidebar-toggle]')
    await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') !== null")
    await waitForRenderer(window, "getComputedStyle(document.querySelector('[data-sidebar-collapsed]')).gridTemplateColumns.startsWith('0px')")
    const collapsed = await collapsedSidebarGeometry(window)
    let collapsedFullscreen: unknown
    let collapsedFullscreenActive: unknown
    await exerciseFullscreen(window, async () => {
      collapsedFullscreen = await collapsedSidebarGeometry(window)
      collapsedFullscreenActive = await window.webContents.executeJavaScript(
        'document.body.dataset.dshFullscreen',
      ) as unknown
    })
    const collapsedAfter = await window.webContents.executeJavaScript(
      'document.body.dataset.dshFullscreen',
    ) as unknown
    await clickAt(window, '[data-sidebar-reveal]')
    await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') === null")
    await waitForRenderer(window, "getComputedStyle(document.querySelector('[data-side=\"sidebar\"]')?.parentElement).gridTemplateColumns.startsWith('350px')")
    const restoredTrack = await window.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('[data-side=\"sidebar\"]')?.parentElement).gridTemplateColumns",
    ) as unknown
    // A reveal cycle must not detach the resize interaction.
    await dragSidebarHandle(window, 380)
    const resizedAfterCycle = await window.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('[data-side=\"sidebar\"]')?.parentElement).gridTemplateColumns",
    ) as unknown

    console.log(`NATIVE_WINDOW_ACCEPTANCE ${JSON.stringify({
      focus,
      window: {
        initialBounds,
        draggedBounds,
        controlBounds,
        minimized: wasMinimized,
        restored: !window.isMinimized(),
      },
      fullscreen: {
        ...(fullscreen as Record<string, unknown>),
        before: fullscreenBefore,
        after: fullscreenAfter,
      },
      renderer: { ...(renderer as Record<string, unknown>), keyboardBeforeMinimize },
      collapse: {
        windowed: collapsed,
        fullscreen: collapsedFullscreen,
        fullscreenActive: collapsedFullscreenActive,
        fullscreenAfter: collapsedAfter,
        restoredTrack,
        resizedAfterCycle,
      },
    })}`)
  } finally {
    other?.destroy()
    window.destroy()
    await stopAfterJourney(lifecycle, true)
  }
}

interface NativeWindowDragStage {
  readonly stage: 'onboarding' | 'expanded' | 'collapsed' | 'control'
  readonly point: { readonly x: number; readonly y: number }
  readonly before: Electron.Rectangle
  readonly after: Electron.Rectangle
}

/** Resolve a safe point inside one drag surface, excluding interactive descendants. */
async function dragSurfacePoint(
  window: BrowserWindow,
  selector: string,
): Promise<{ x: number; y: number }> {
  const clientPoint = await window.webContents.executeJavaScript(`(() => {
    const surface = document.querySelector(${JSON.stringify(selector)});
    if (!(surface instanceof HTMLElement)) return null;
    const box = surface.getBoundingClientRect();
    const interactive = 'button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';
    for (let y = Math.ceil(box.top + 4); y < Math.floor(box.bottom - 4); y += 6) {
      for (let x = Math.floor(box.right - 4); x > Math.ceil(box.left + 4); x -= 6) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !surface.contains(hit) || hit.closest(interactive) !== null) continue;
        return { x, y };
      }
    }
    return null;
  })()`) as { x: number; y: number } | null
  if (clientPoint === null) {
    throw new Error(`desktop native drag acceptance: ${selector} has no safe drag point`)
  }
  const bounds = window.getBounds()
  return { x: bounds.x + clientPoint.x, y: bounds.y + clientPoint.y }
}

/** Resolve the center of one no-drag control in screen coordinates. */
async function controlPoint(
  window: BrowserWindow,
  selector: string,
): Promise<{ x: number; y: number }> {
  const clientPoint = await window.webContents.executeJavaScript(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!(control instanceof HTMLElement)) return null;
    const box = control.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`) as { x: number; y: number } | null
  if (clientPoint === null) {
    throw new Error(`desktop native drag acceptance: ${selector} has no control point`)
  }
  const bounds = window.getBounds()
  return { x: bounds.x + clientPoint.x, y: bounds.y + clientPoint.y }
}

/** Publish one OS-pointer target and assert the resulting native move contract. */
async function acceptNativeDragStage(
  window: BrowserWindow,
  stage: NativeWindowDragStage['stage'],
  selector: string,
  shouldMove: boolean,
): Promise<NativeWindowDragStage> {
  window.setBounds({ x: 40, y: 60, width: 1160, height: 700 })
  window.show()
  window.focus()
  await new Promise(resolveWait => setTimeout(resolveWait, 250))
  const point = shouldMove
    ? await dragSurfacePoint(window, selector)
    : await controlPoint(window, selector)
  const before = window.getBounds()
  const moved = new Promise<boolean>((resolveMove) => {
    window.once('move', () => { resolveMove(true) })
  })
  console.log(`NATIVE_WINDOW_DRAG_READY ${JSON.stringify({ stage, point })}`)
  const didMove = await Promise.race([
    moved,
    new Promise<boolean>(resolveWait => setTimeout(() => { resolveWait(false) }, shouldMove ? 15_000 : 3_000)),
  ])
  if (didMove) await new Promise(resolveWait => setTimeout(resolveWait, 300))
  const after = window.getBounds()
  const changed = after.x !== before.x || after.y !== before.y
  if (changed !== shouldMove) {
    throw new Error(
      `desktop native drag acceptance: ${stage} expected move=${String(shouldMove)}; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
  }
  const result = { stage, point, before, after }
  console.log(`NATIVE_WINDOW_DRAG_STAGE ${JSON.stringify(result)}`)
  return result
}

/** Exercise real AppKit window movement through externally injected OS pointer events. */
async function acceptNativeWindowDrag(lifecycle: DesktopLifecycle): Promise<void> {
  const { window, ready } = bootWindow(lifecycle)
  await ready
  if (lifecycle.phase !== 'running') {
    throw new Error(`desktop native drag acceptance: Host did not reach the running phase (${lifecycle.phase})`)
  }
  const stages: NativeWindowDragStage[] = []
  try {
    await waitForRenderer(window, "document.querySelector('#root > *') && document.querySelector('textarea')")
    await waitForRenderer(window, "document.querySelector('[role=\"dialog\"] [data-window-drag-surface]')", 60_000)
    stages.push(await acceptNativeDragStage(
      window,
      'onboarding',
      '[role="dialog"] [data-window-drag-surface]',
      true,
    ))
    await completeOnboarding(window)

    const { sessionId } = await reachLiveComposer(currentSupervisor(lifecycle), window)
    await submitRecordedPrompt(window, RECORDED_PROMPT)
    await waitForTurnCompleted(currentSupervisor(lifecycle), window, sessionId, {
      toolName: 'bash',
      toolResultContains: 'TERMINAL_OK',
      settledSelector: SETTLED_BASH_CARD,
    })
    await waitForRenderer(window, "document.querySelector('[data-conversation-header]:not([aria-hidden=\"true\"])')")

    if (await window.webContents.executeJavaScript("document.querySelector('[data-sidebar-reveal]') !== null")) {
      await clickAt(window, '[data-sidebar-reveal]')
      await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') === null")
    }
    stages.push(await acceptNativeDragStage(window, 'expanded', '[data-sidebar-control-row]', true))

    await clickAt(window, '[data-sidebar-toggle]')
    await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') !== null")
    stages.push(await acceptNativeDragStage(
      window,
      'collapsed',
      '[data-conversation-header]:not([aria-hidden="true"])',
      true,
    ))
    stages.push(await acceptNativeDragStage(window, 'control', LIVE_COMPOSER, false))
    const activeElement = await window.webContents.executeJavaScript(
      'document.activeElement?.tagName ?? null',
    ) as unknown
    if (activeElement !== 'TEXTAREA') {
      throw new Error(`desktop native drag acceptance: no-drag control did not remain interactive (${String(activeElement)})`)
    }
    console.log(`NATIVE_WINDOW_DRAG_ACCEPTANCE ${JSON.stringify({ stages, activeElement })}`)
  } finally {
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
interface ReplayInvocation {
  readonly replayFile?: string
  readonly childReplays: string[]
}

/** Parse `--smoke-replay <file>` and repeated `--smoke-child-replay <file>` arguments. */
function parseReplayInvocation(argv: readonly string[]): ReplayInvocation {
  let replayFile: string | undefined
  const childReplays: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--smoke-replay' && arg !== '--smoke-child-replay') continue
    const value = argv[index + 1]
    if (typeof value !== 'string' || value === '' || value.startsWith('-')) continue
    if (arg === '--smoke-replay') replayFile = value
    else childReplays.push(value)
    index += 1
  }
  return { ...(replayFile === undefined ? {} : { replayFile }), childReplays }
}

/**
 * Record truthful renderer frames of the real packaged window: launch, focus
 * transitions, the drag-region input attempt, keyboard operation, minimize/
 * restore, native full-screen transition, light/dark appearance, and the
 * replayed tracer-bullet turn in the
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
  // Keep the window above SIDEBAR_AUTO_COLLAPSE (1024px). Work-area clamping
  // can narrow it again, so the phase re-expands the sidebar before dragging
  // when necessary.
  window.setBounds({ x: 120, y: 120, width: 1160, height: 700 })
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
    await recorder.capture('native-drag-surface')

    const blurred = onceWindowEvent(window, 'blur')
    other = new BrowserWindow({ width: 240, height: 160, show: true })
    other.focus()
    await blurred
    await recorder.capture('inactive')
    const focused = onceWindowEvent(window, 'focus')
    window.focus()
    await focused
    await recorder.capture('active')

    // Synthetic input exercises the compact drag region without OS-level pointer
    // permissions; the evidence line records the resulting bounds against the
    // bounds macOS actually granted — displays shorter than the requested
    // rect (the CI arm64 runner) clamp it, and that granted position is the
    // truthful baseline the attempt must leave unchanged.
    const initialBounds = window.getBounds()
    window.webContents.sendInputEvent({ type: 'mouseDown', x: 480, y: 20, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 520, y: 60, movementX: 40, movementY: 40 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 520, y: 60, button: 'left', clickCount: 1 })
    const dragAttemptBounds = window.getBounds()
    await recorder.capture('drag-region-attempt')

    const { sessionId, workspaceId } = await reachLiveComposer(currentSupervisor(lifecycle), window)
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

    await exerciseFullscreen(window, () => recorder.capture('fullscreen'))

    // Capture the collapsed layout in both windowed and full-screen geometry;
    // work-area clamping may require an explicit reveal before the toggle is
    // available.
    if (await window.webContents.executeJavaScript("document.querySelector('[data-sidebar-reveal]') !== null")) {
      await clickAt(window, '[data-sidebar-reveal]')
      await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') === null")
    }
    await clickAt(window, '[data-sidebar-toggle]')
    await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') !== null")
    await new Promise(resolveWait => setTimeout(resolveWait, 400))
    await recorder.capture('sidebar-collapsed')
    await exerciseFullscreen(window, () => recorder.capture('fullscreen-collapsed'))
    await clickAt(window, '[data-sidebar-reveal]')
    await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') === null")
    await new Promise(resolveWait => setTimeout(resolveWait, 400))
    await recorder.capture('sidebar-revealed')

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
      await submitRecordedPrompt(window, RECORDED_PROMPT)
      await waitForTurnCompleted(currentSupervisor(lifecycle), window, sessionId, {
        toolName: 'bash',
        toolResultContains: 'TERMINAL_OK',
        settledSelector: SETTLED_BASH_CARD,
      })
      console.log('SMOKE_OK terminal')
    } catch (error) {
      scenarioFailure = error instanceof Error ? error.message : String(error)
    } finally {
      capturing = false
    }
    await poll
    await recorder.capture('tracer-settled')

    // The settled Session exposes its title and Chat/Trajectory header, so
    // these frames carry the collapsed-header alignment contract that the
    // earlier blank-composer frames intentionally omit.
    await clickAt(window, '[data-sidebar-toggle]')
    await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') !== null")
    await new Promise(resolveWait => setTimeout(resolveWait, 400))
    await recorder.capture('session-sidebar-collapsed')
    await exerciseFullscreen(window, () => recorder.capture('session-fullscreen-collapsed'))
    await clickAt(window, '[data-sidebar-reveal]')
    await waitForRenderer(window, "document.querySelector('[data-sidebar-reveal]') === null")

    // Interaction parity through the assembled renderer: the question turn is
    // answered in the real question composer, and the approval turn switches
    // the real access-mode chip, waits for the real approval panel, and clicks
    // Allow once — the same user gestures the Web product serves.
    const supervisor = currentSupervisor(lifecycle)
    const questionSessionId = await startSessionThroughProduct(supervisor, window, workspaceId, 'record-question-session')
    console.log('SMOKE_OK question-session')
    await submitRecordedPrompt(window, QUESTION_PROMPT, true)
    await waitForRenderer(window, "document.querySelector('[data-question-key]') !== null", 60_000)
    await recorder.capture('question-pending')
    await answerQuestionComposer(window)
    await waitForTurnCompleted(supervisor, window, questionSessionId, {
      toolName: 'ask_user_question',
      toolResultContains: JSON.stringify(QUESTION_ANSWER),
      goneSelector: '[data-question-key]',
    })
    console.log('SMOKE_OK question')
    await recorder.capture('question-settled')

    const approvalSessionId = await startSessionThroughProduct(supervisor, window, workspaceId, 'record-approval-session')
    await switchAccessModeReadOnly(window)
    console.log('SMOKE_OK approval-session')
    // A stale notes.txt from an earlier run must not satisfy the assertion:
    // remove it so the escalated write is the only source of the file.
    const approvalFile = join(app.getPath('userData'), 'acceptance-workspace', APPROVAL_FILE)
    rmSync(approvalFile, { force: true })
    await submitRecordedPrompt(window, APPROVAL_PROMPT, true)
    await waitForRenderer(window, "document.querySelector('[data-approval-key]') !== null", 120_000)
    await recorder.capture('approval-pending')
    await allowApprovalOnce(window)
    await waitForTurnCompleted(supervisor, window, approvalSessionId, {
      toolName: 'bash',
      settledSelector: SETTLED_BASH_CARD,
      goneSelector: '[data-approval-key]',
    })
    if (!existsSync(approvalFile) || !readFileSync(approvalFile, 'utf8').trim().startsWith('tok63z')) {
      throw new Error('desktop recording: the escalated command did not write notes.txt into the workspace')
    }
    console.log('SMOKE_OK approval')
    await recorder.capture('approval-settled')

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
      questionSessionId,
      approvalSessionId,
      approvalFile,
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
    const { sessionId } = await reachLiveComposer(currentSupervisor(lifecycle), window)
    const keyboard = await typeIntoComposer(window)
    await recorder.capture('session-recovered')
    console.log('SMOKE_OK session')

    try {
      await submitRecordedPrompt(window, RECORDED_PROMPT)
      await waitForTurnCompleted(currentSupervisor(lifecycle), window, sessionId, {
        toolName: 'bash',
        toolResultContains: 'TERMINAL_OK',
        settledSelector: SETTLED_BASH_CARD,
      })
      console.log('SMOKE_OK terminal')
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

/**
 * Record the installed renderer's native-picker and path-opening journey while
 * substituting only the nondeterministic operating-system boundary. The real
 * window, preload bridge, ApiProxy, reverse child IPC, Workspace adoption, and
 * Session navigation remain assembled; structured evidence accompanies the
 * renderer frames because `capturePage()` cannot see native dialogs.
 */
async function recordNativeActions(lifecycle: DesktopLifecycle): Promise<void> {
  const framesDir = process.env.DSH_DESKTOP_FRAMES_DIR
  if (framesDir === undefined || framesDir.trim() === '') {
    throw new Error('desktop native-actions recording requires DSH_DESKTOP_FRAMES_DIR')
  }
  const harnessHome = process.env.DSH_HOME
  if (harnessHome === undefined || harnessHome.trim() === '') {
    throw new Error('desktop native-actions recording requires DSH_HOME')
  }
  const workspacePath = join(harnessHome, 'native-actions-workspace')
  const openedPath = join(workspacePath, 'opened.txt')
  const missingPath = join(workspacePath, 'missing.txt')
  await mkdir(framesDir, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  await writeFile(openedPath, 'native action acceptance\n')
  const canonicalWorkspacePath = await realpath(workspacePath)

  const picked: string[] = []
  const opened: string[] = []
  const failures: Array<{ path: string; message: string }> = []
  const nativePlatform: DesktopNativePlatform = {
    pickDirectory() {
      picked.push(workspacePath)
      return Promise.resolve(workspacePath)
    },
    pathAvailable: statAvailable,
    openPath(path) {
      opened.push(path)
      return Promise.resolve('')
    },
    reportFailure(path, message) {
      failures.push({ path, message })
      return Promise.resolve()
    },
  }

  const { window, ready } = bootWindow(lifecycle, nativePlatform)
  await ready
  if (lifecycle.phase !== 'running') {
    throw new Error(`desktop native-actions recording: Host did not reach the running phase (${lifecycle.phase})`)
  }
  const recorder = createFrameRecorder(window, framesDir)
  window.show()
  window.focus()
  try {
    const workspace = await reachLiveComposerThroughNativePicker(
      currentSupervisor(lifecycle),
      window,
      canonicalWorkspacePath,
      () => picked.length > 0,
    )
    if (!workspace.visible) {
      throw new Error('desktop native-actions recording: adopted workspace is not visible')
    }
    await recorder.capture('directory-picked')
    console.log('SMOKE_OK native-directory')

    const success = await rendererRpc(window, 'native-open-success', 'host.openPath', { path: openedPath })
    if (!success.ok || success.value['opened'] !== true) {
      throw new Error(`desktop native-actions recording: eligible path did not open: ${JSON.stringify(success)}`)
    }
    await recorder.capture('path-opened')
    console.log('SMOKE_OK native-open')

    const failure = await rendererRpc(window, 'native-open-failure', 'host.openPath', { path: missingPath })
    if (failure.ok || !failure.error.message.includes(`path is unavailable: ${missingPath}`)) {
      throw new Error(`desktop native-actions recording: missing path was not rejected actionably: ${JSON.stringify(failure)}`)
    }
    await recorder.capture('path-failure')
    console.log('SMOKE_OK native-failure')

    console.log(`NATIVE_ACTIONS_RECORDING ${JSON.stringify({
      framesDir,
      frames: recorder.frames,
      workspace: { path: workspacePath, ...workspace },
      picked,
      opened,
      failures,
      success,
      failure,
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
    await window.loadURL(`data:text/html,${encodeURIComponent(`
      <style>
        body {
          --dsw-alias-bg-base: rgb(249, 250, 251);
          --dsw-static-neutral-bluish-50: rgb(249, 250, 251);
          --dsw-static-neutral-bluish-900: rgb(27, 27, 28);
          --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);
        }
        body[data-ds-dark-theme] {
          --dsw-alias-bg-base: rgb(15, 17, 21);
          --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08);
        }
      </style>
      <div data-dsh-frame-surface>
        <aside data-dsh-sidebar-surface>
          <button id="control">Control</button>
          <button data-sidebar-new-session>New Session</button>
          <div role="treeitem" aria-selected="true">Selected Session</div>
        </aside>
        <main data-slot="conversation" data-dsh-conversation-surface>
          <header data-conversation-header>Conversation</header>
          <textarea id="editor"></textarea>
        </main>
        <section data-dsh-details-surface>Details</section>
      </div>
    `)}`)
    await window.webContents.insertCSS(DESKTOP_SURFACE_CSS)
    const state = rendererSurfaceState(
      nativeTheme.shouldUseDarkColors,
      nativeTheme.prefersReducedTransparency,
      process.platform,
    )
    const renderer = await window.webContents.executeJavaScript(`
      document.body.dataset.dshPlatform = ${JSON.stringify(state.platform)};
      document.body.dataset.dshFullscreen = 'false';
      const inspectSurface = (appearance, material) => {
        document.body.toggleAttribute('data-ds-dark-theme', appearance === 'dark');
        document.body.dataset.dshAppearance = appearance;
        document.body.dataset.dshSidebarMaterial = material;
        const color = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
        return {
          frame: color('[data-dsh-frame-surface]'),
          sidebar: color('[data-dsh-sidebar-surface]'),
          conversation: color('[data-dsh-conversation-surface]'),
          details: color('[data-dsh-details-surface]'),
          newSession: color('[data-sidebar-new-session]'),
          selectedSession: color('[role="treeitem"][aria-selected="true"]'),
        };
      };
      document.querySelector('#control').focus();
      ({
        activeElement: document.activeElement?.id,
        systemState: ${JSON.stringify(state)},
        surfaces: {
          glassLight: inspectSurface('light', 'glass-light'),
          glassDark: inspectSurface('dark', 'glass-dark'),
          opaqueLight: inspectSurface('light', 'opaque-light'),
          opaqueDark: inspectSurface('dark', 'opaque-dark'),
        },
        controlRegion: getComputedStyle(document.querySelector('#control')).webkitAppRegion,
        dragRegion: getComputedStyle(document.querySelector('[data-conversation-header]')).webkitAppRegion,
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
    const home = process.env.DSH_HOME ?? ''
    if (home === '') throw new Error('desktop smoke requires an explicit DSH_HOME')
    await runSmokeScenario(current.supervisor, current.childPid ?? process.pid, home)
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

/**
 * Keyless reopen mode: the second packaged launch over the first launch's
 * durable home. Runs the reopen assertions without a window or a model call
 * and exits with the scenario's verdict.
 * @param lifecycle - the supervised Host lifecycle.
 * @param home - the harness home whose durable records are reopened.
 */
async function bootSmokeReopen(lifecycle: DesktopLifecycle, home: string): Promise<number> {
  try {
    // The reopen assertions compare durable records the child reads from its
    // own DSH_HOME: a divergent --smoke-home would silently assert a foreign
    // directory, so reject the mismatch up front.
    if (process.env.DSH_HOME !== home) {
      throw new Error(
        `desktop smoke reopen: --smoke-home ${home} does not match DSH_HOME ${process.env.DSH_HOME ?? '<unset>'}`,
      )
    }
    await lifecycle.start()
    if (lifecycle.phase !== 'running') {
      throw new Error(`desktop smoke reopen: Host did not reach the running phase (${lifecycle.phase})`)
    }
    const current = lifecycle.current()
    if (current === undefined) throw new Error('desktop smoke reopen: no DSH generation after start')
    await runSmokeReopen(current.supervisor, home)
    const report = await lifecycle.stop()
    if (!report.quiescent) {
      console.error(`SMOKE_QUIT_FAILED ${JSON.stringify(report.failure)}`)
      return 1
    }
    console.log('SMOKE_OK reopen-quit')
    console.log('SMOKE_PASS')
    return 0
  } catch (error) {
    console.error(`desktop smoke reopen failed: ${error instanceof Error ? error.message : String(error)}`)
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
    const nativeDragAcceptance = process.argv.includes('--accept-native-window-drag')
    const recording = process.argv.includes('--record-native-window')
    const nativeActionsRecording = process.argv.includes('--record-native-actions')
    const recoveryRecording = process.argv.includes('--record-recovery')
    const sidebarGlassAcceptance = parseSidebarGlassAcceptanceInvocation(process.argv)
    const smoke = parseSmokeInvocation(process.argv)
    const smokeReopen = parseSmokeReopenInvocation(process.argv)
    const headlessBoot = smoke !== undefined || smokeReopen !== undefined
      || nativeDragAcceptance
      || recording || nativeActionsRecording || recoveryRecording
      || sidebarGlassAcceptance !== undefined
    const options = app.isPackaged
      ? packagedChildOptions(headlessBoot)
      : developmentChildOptions()
    const lifecycle = new DesktopLifecycle({
      spawn: () => spawnDshChild(options),
    })
    lifecycle.onPhase((phase) => { console.error(`[desktop-main] Host phase: ${phase}`) })
    const webDist = app.isPackaged
      ? packagedRuntimeLayout(process.resourcesPath, app.getPath('userData')).webDist
      : resolve(packageDir('@deepseek-ai/dsh-web-frontend'), 'dist')
    registerAssetProtocol(webDist)
    const headless = smoke !== undefined || smokeReopen !== undefined || acceptance
      || nativeDragAcceptance
      || recording || nativeActionsRecording || recoveryRecording
      || sidebarGlassAcceptance !== undefined
    installQuitOwner(lifecycle, () => currentWindow, headless)

    if (nativeDragAcceptance) {
      // The external pointer driver may fail independently of Electron. Its
      // SIGTERM cleanup request must still enter the application's one quit
      // owner so the supervised Host reaches quiescence before Electron exits.
      const requestQuit = (): void => { app.quit() }
      process.once('SIGTERM', requestQuit)
      const replay = parseReplayInvocation(process.argv)
      if (replay.replayFile === undefined) {
        console.error('desktop native drag acceptance requires --smoke-replay <file>')
        process.off('SIGTERM', requestQuit)
        app.exit(1)
        return
      }
      const replayProvider = app.isPackaged
        ? packagedRuntimeLayout(process.resourcesPath, app.getPath('userData')).replayProvider
        : packageDir('@deepseek-ai/dsh-llm-replay')
      prepareSmokeProfile(replay.replayFile, replayProvider, replay.childReplays)
      try {
        await acceptNativeWindowDrag(lifecycle)
      } catch (error) {
        console.error(`desktop native drag acceptance failed: ${error instanceof Error ? error.message : String(error)}`)
        await lifecycle.stop().catch((stopError: unknown) => {
          console.error('desktop native drag acceptance failed to stop after failure:', stopError)
        })
        app.exit(1)
        return
      } finally {
        process.off('SIGTERM', requestQuit)
      }
      app.exit(0)
      return
    }

    if (nativeActionsRecording) {
      try {
        await recordNativeActions(lifecycle)
      } catch (error) {
        console.error(`desktop native-actions recording failed: ${error instanceof Error ? error.message : String(error)}`)
        await lifecycle.stop().catch((stopError: unknown) => {
          console.error('desktop native-actions recording failed to stop after failure:', stopError)
        })
        app.exit(1)
        return
      }
      app.exit(0)
      return
    }

    if (recording || recoveryRecording) {
      const replay = parseReplayInvocation(process.argv)
      if (replay.replayFile === undefined) {
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
      if (recording) prepareSmokeProfile(replay.replayFile, replayProvider, replay.childReplays)
      else prepareBrokenProfile()
      try {
        if (recording) await recordNativeWindow(lifecycle)
        else await recordRecovery(lifecycle, replay.replayFile, replayProvider)
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
      prepareSmokeProfile(replayFile, replayProvider, smoke.childReplays)
      app.exit(await bootSmoke(lifecycle))
      return
    }
    if (smokeReopen !== undefined) {
      if (smokeReopen.home === undefined) {
        console.error('desktop smoke reopen requires --smoke-home <dir>')
        app.exit(1)
        return
      }
      // The first launch already seeded the profile (bundles, keyless replay
      // patch, and the replay-provider fallback link); the reopen launch boots
      // that exact durable home untouched.
      app.exit(await bootSmokeReopen(lifecycle, smokeReopen.home))
      return
    }
    if (sidebarGlassAcceptance !== undefined) {
      if (sidebarGlassAcceptance.phase === undefined) {
        console.error('desktop sidebar glass acceptance requires --sidebar-glass-phase <default-off|reopen-on|reopen-enabled>')
        app.exit(1)
        return
      }
      try {
        await acceptSidebarGlass({
          bootWindow: () => bootWindow(lifecycle),
          hostPhase: () => lifecycle.phase,
          completeOnboarding,
          clickAt,
          waitForRenderer,
          nativeThemeState: () => ({
            source: nativeTheme.themeSource,
            dark: nativeTheme.shouldUseDarkColors,
          }),
          supervisor: () => currentSupervisor(lifecycle),
          stop: () => stopAfterJourney(lifecycle, true),
        }, sidebarGlassAcceptance.phase)
      } catch (error) {
        console.error(`desktop sidebar glass acceptance failed: ${error instanceof Error ? error.message : String(error)}`)
        await lifecycle.stop().catch((stopError: unknown) => {
          console.error('desktop sidebar glass acceptance failed to stop after failure:', stopError)
        })
        app.exit(1)
        return
      }
      app.exit(0)
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
