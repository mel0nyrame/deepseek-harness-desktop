/** Electron desktop entry: development shell and packaged application. */

import { fork } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app, BrowserWindow, ipcMain, net, protocol,
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
async function bootWindow(supervisor: DshSupervisor, webDist: string): Promise<void> {
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
    // Plain window chrome for the tracer bullet: inset traffic lights,
    // vibrancy, and transparent surfaces are the native window experience of
    // issue #4, which owns their acceptance and fallback behavior.
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
    const smoke = parseSmokeInvocation(process.argv)
    const options = app.isPackaged ? packagedChildOptions(smoke !== undefined) : developmentChildOptions()
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
    await bootWindow(supervisor, webDist)
  })().catch((error: unknown) => {
    console.error(`desktop app failed to start: ${String(error)}`)
    app.exit(1)
  })
})
