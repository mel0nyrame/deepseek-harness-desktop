import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { healProfilesModuleFallback } from '@deepseek-ai/dsh-app-boot'
import { bootstrapDesktopProfile } from '@dsh-desktop/bundle/profile-bootstrap'
import {
  parseDesktopBridgeRequest,
  parseDesktopParentMessage,
  type DesktopChildMessage,
} from '@dsh-desktop/connection'
import { desktopWindowWebPreferences } from '@dsh-desktop/connection/preload'
import { DshSupervisor, type SupervisorOptions } from './supervisor.js'
import { isTrustedRendererUrl } from './renderer-policy.js'
import {
  parseTracerInvocation,
  prepareTracerProfile,
  type TracerInvocation,
} from './tracer.js'

const shellRoot = resolve(import.meta.dirname, '..')
const rendererPath = join(shellRoot, 'renderer.html')
let supervisor: DshSupervisor | undefined
let shutdownComplete = false
let shutdown: Promise<void> | undefined

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
  return !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && isTrustedRendererUrl(event.senderFrame.url, rendererPath)
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

async function captureTracer(window: BrowserWindow, tracer: TracerInvocation): Promise<void> {
  let previous = ''
  let frame = 0
  const deadline = Date.now() + 120_000
  for (;;) {
    const state = await window.webContents.executeJavaScript('document.body.dataset.state') as unknown
    if (typeof state === 'string' && state !== previous) {
      previous = state
      console.log(`TRACER_STATE ${state}`)
      if (state === 'starting') await assertTracerLayout(window)
      if (tracer.framesDir !== undefined) {
        mkdirSync(tracer.framesDir, { recursive: true })
        const image = await window.webContents.capturePage()
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

async function startRuntime(runtime: DshSupervisor, options: Parameters<DshSupervisor['start']>[0]): Promise<Awaited<ReturnType<DshSupervisor['start']>>> {
  try {
    return await runtime.start(options)
  } catch (firstError) {
    if (shutdown !== undefined) throw firstError
    console.error('[desktop-main] initial child generation failed; restarting once:', firstError)
    return await runtime.restart()
  }
}

async function run(): Promise<void> {
  const root = runtimeRoot()
  const home = harnessHome()
  const tracer = parseTracerInvocation(process.argv)
  bootstrapDesktopProfile({
    home,
    resolveComponentVersion: packageName => resolveComponentVersion(root, packageName),
  })
  healProfilesModuleFallback(join(root, 'package.json'), home)
  if (tracer !== undefined) {
    prepareTracerProfile(
      home,
      join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-replay'),
      tracer.replayFile,
    )
  }

  const observeProcesses = processEvidenceObserver()
  const runtime = new DshSupervisor(undefined, observeProcesses === undefined
    ? {}
    : { onProcessSnapshot: observeProcesses })
  supervisor = runtime
  const options = {
    executable: process.execPath,
    cliEntry: join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    runtimeRoot: root,
    home,
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
    backgroundColor: '#090d18',
    webPreferences: desktopWindowWebPreferences(join(shellRoot, 'lib', 'preload.cjs')),
  })
  const preventUnknownNavigation = (event: Electron.Event, url: string): void => {
    if (!isTrustedRendererUrl(url, rendererPath)) event.preventDefault()
  }
  window.webContents.on('will-navigate', preventUnknownNavigation)
  window.webContents.on('will-redirect', preventUnknownNavigation)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const disposeCarrier = installCarrier(runtime, window)
  window.on('closed', disposeCarrier)
  await window.loadFile(rendererPath, {
    query: tracer === undefined ? {} : { tracer: '1' },
  })
  if (tracer !== undefined) {
    window.show()
    await captureTracer(window, tracer)
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
