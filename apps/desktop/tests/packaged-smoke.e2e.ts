/**
 * Keyless packaged-application smoke: launch the installed macOS bundle's
 * binary in `--smoke` mode against a fresh harness home and assert the
 * tracer-bullet markers, a zero exit, and quiescence of the owned process
 * tree. This is the acceptance evidence that the packaged app starts outside
 * the source tree — bundled production runtime, Electron-ABI node-pty, real
 * spawn helper, terminate-and-join — because every failure mode surfaces as a
 * non-zero exit or a missing `SMOKE_OK` stage marker in the captured output.
 *
 * Requires `pnpm --filter @deepseek-ai/dsh-desktop run package` to have
 * produced the application bundle. The suite self-skips when the bundle is
 * absent (development machines and non-macOS lanes); the macOS CI job sets
 * `DSH_DESKTOP_SMOKE_REQUIRED=1` after packaging, which turns the absence
 * into a hard failure so the packaged smoke can never silently drop out.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** Discover the produced bundle: electron-builder names its output dir mac or mac-<arch>. */
function findAppPath(): string | undefined {
  const distDir = join(REPO_ROOT, 'apps', 'desktop', 'dist')
  if (!existsSync(distDir)) return undefined
  for (const entry of readdirSync(distDir)) {
    if (!entry.startsWith('mac')) continue
    const candidate = join(distDir, entry, 'DSH Desktop.app')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const APP_PATH = process.env.DSH_DESKTOP_APP_DIR ?? findAppPath() ?? join(REPO_ROOT, 'apps', 'desktop', 'dist', 'mac', 'DSH Desktop.app')
const APP_BINARY = join(APP_PATH, 'Contents', 'MacOS', 'DSH Desktop')
const REPLAY_FIXTURE = join(REPO_ROOT, 'examples', 'acp-agent', 'tests', 'snapshots', 'bash-tool-turn', 'session.jsonl')
const REQUIRED = process.env.DSH_DESKTOP_SMOKE_REQUIRED === '1'

describe('packaged desktop application', () => {
  let home: string | undefined
  let child: ChildProcess | undefined

  afterEach(async () => {
    // A failed assertion must not leave the installed application running.
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => { child!.once('exit', () => { resolve() }) })
      child.kill('SIGKILL')
      await exited
    }
    child = undefined
    if (home !== undefined) await rm(home, { recursive: true, force: true })
    home = undefined
  })

  /** Launch the installed binary with a fresh harness home and capture its verdict. */
  async function launchInstalledApp(
    homeDir: string,
    args: string[],
    extraEnv: Record<string, string> = {},
  ): Promise<{ exitCode: number | null; captured: string }> {
    const env = { ...process.env }
    // The application binary must launch as an app, not as a Node runtime.
    delete env['ELECTRON_RUN_AS_NODE']
    delete env['DSH_NODE_EXECUTABLE']
    Object.assign(env, {
      DSH_HOME: homeDir,
      DSH_AGENTS_HOME: join(homeDir, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'keyless-desktop-no-call',
      ...extraEnv,
    })

    const output: string[] = []
    let spawnFailure: string | undefined
    const exitCode = await new Promise<number | null>((resolve) => {
      child = spawn(APP_BINARY, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', (chunk: Buffer) => { output.push(String(chunk)) })
      child.stderr?.on('data', (chunk: Buffer) => { output.push(String(chunk)) })
      child.on('error', (error) => { spawnFailure = String(error) })
      child.on('close', (code) => { resolve(code) })
    })
    const captured = `${spawnFailure === undefined ? '' : `spawn error: ${spawnFailure}\n`}${output.join('')}`
    return { exitCode, captured }
  }

  /** Fail loudly unless pgrep finds no surviving process of the installed app. */
  function assertNoSurvivors(): void {
    let survivors = ''
    try {
      survivors = execFileSync('pgrep', ['-f', APP_PATH], { encoding: 'utf8' })
    } catch (error) {
      // pgrep exits 1 when nothing matches, which is the passing case.
      expect((error as { status?: number }).status).toBe(1)
    }
    expect(survivors.trim()).toBe('')
  }

  it('has a packaged application when the gate requires it', () => {
    expect(REQUIRED && !existsSync(APP_BINARY)).toBe(false)
  })

  it.skipIf(process.platform !== 'darwin' || !existsSync(APP_BINARY))(
    'reports configured native state from a real installed BrowserWindow',
    async () => {
      home = await mkdtemp(join(tmpdir(), 'dsh-desktop-native-window-'))
      const { exitCode, captured } = await launchInstalledApp(home, ['--inspect-native-window'])

      expect(exitCode, `native inspection exited ${String(exitCode)}; output:\n${captured.slice(0, 4000)}`).toBe(0)
      const line = captured.split('\n').find(value => value.startsWith('NATIVE_WINDOW_STATE '))
      expect(line).toBeDefined()
      const state = JSON.parse(line!.slice('NATIVE_WINDOW_STATE '.length)) as {
        options: Record<string, unknown>
        actual: { backgroundColor: string; focusable: boolean }
        renderer: {
          activeElement: string
          systemState: { appearance: string; transparency: string }
          surfaces: {
            lightEnabled: string
            darkEnabled: string
            lightReduced: string
            darkReduced: string
          }
          controlRegion: string
          dragRegion: string
        }
      }
      expect(state.options).toMatchObject({
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 14 },
        transparent: true,
        vibrancy: 'under-window',
        visualEffectState: 'followWindow',
      })
      expect(state.actual).toEqual({ backgroundColor: '#000000', focusable: true })
      expect(state.renderer.activeElement).toBe('control')
      expect(state.renderer.systemState.appearance).toMatch(/^(light|dark)$/)
      expect(state.renderer.systemState.transparency).toMatch(/^(enabled|reduced)$/)
      expect(state.renderer.surfaces.lightEnabled).toBe('rgba(0, 0, 0, 0)')
      expect(state.renderer.surfaces.darkEnabled).toBe('rgba(0, 0, 0, 0)')
      expect(state.renderer.surfaces.lightReduced).toBe('rgba(249, 250, 251, 0.98)')
      expect(state.renderer.surfaces.darkReduced).toBe('rgba(15, 17, 21, 0.98)')
      expect(state.renderer.controlRegion).toBe('no-drag')
      expect(state.renderer.dragRegion).toBe('drag')
      child = undefined
    },
    60_000,
  )

  it.skipIf(process.platform !== 'darwin' || !existsSync(APP_BINARY))(
    'operates the assembled renderer through a visible native window',
    async () => {
      home = await mkdtemp(join(tmpdir(), 'dsh-desktop-native-acceptance-'))
      const hangKill = setTimeout(() => {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 120_000)
      const { exitCode, captured } = await launchInstalledApp(home, ['--accept-native-window'])
      clearTimeout(hangKill)

      expect(exitCode, `native acceptance exited ${String(exitCode)}; output:\n${captured.slice(0, 8000)}`).toBe(0)
      const line = captured.split('\n').find(value => value.startsWith('NATIVE_WINDOW_ACCEPTANCE '))
      expect(line).toBeDefined()
      const state = JSON.parse(line!.slice('NATIVE_WINDOW_ACCEPTANCE '.length)) as {
        focus: string[]
        window: {
          initialBounds: { x: number; y: number; width: number; height: number }
          draggedBounds: { x: number; y: number; width: number; height: number }
          controlBounds: { x: number; y: number; width: number; height: number }
          minimized: boolean
          restored: boolean
        }
        renderer: {
          assembled: boolean
          root: { top: number; bottom: number; height: number }
          viewportHeight: number
          dragRegion: string
          controlRegion: string
          activeElement: string
          keyboardValue: string
          keyboardBeforeMinimize: { activeElement: string; value: string }
        }
      }
      expect(state.focus.slice(0, 3)).toEqual(['active', 'inactive', 'active'])
      expect(state.focus.length).toBeGreaterThanOrEqual(3)
      expect(state.window.minimized).toBe(true)
      expect(state.window.restored).toBe(true)
      expect(state.window.draggedBounds).toEqual(state.window.initialBounds)
      expect(state.window.controlBounds).toEqual(state.window.initialBounds)
      expect(state.renderer.assembled).toBe(true)
      expect(state.renderer.root.top).toBe(44)
      expect(state.renderer.root.bottom).toBeLessThanOrEqual(state.renderer.viewportHeight)
      expect(state.renderer.root.height).toBe(state.renderer.viewportHeight - 44)
      expect(state.renderer.dragRegion).toBe('drag')
      expect(state.renderer.controlRegion).toBe('no-drag')
      // Keyboard evidence is captured before minimize: the assembled client's
      // own focus handling runs again after restore, so post-restore focus is
      // app behavior, not a drag-region or keyboard claim.
      expect(state.renderer.keyboardBeforeMinimize).toEqual({ activeElement: 'TEXTAREA', value: 'KEYBOARD_OK' })
      expect(state.renderer.keyboardValue).toBe('KEYBOARD_OK')
      child = undefined
    },
    180_000,
  )

  it.skipIf(process.platform !== 'darwin' || !existsSync(APP_BINARY))(
    'records truthful real-app frames of window interaction, appearance, and the tracer bullet',
    async () => {
      home = await mkdtemp(join(tmpdir(), 'dsh-desktop-native-recording-'))
      const framesDir = join(REPO_ROOT, '.playwright-mcp', 'gif-frames-issue4-native')
      // One storyboard is one evidence run: start from a fresh frame root.
      await rm(framesDir, { recursive: true, force: true })
      const replayFile = join(home, 'replay.jsonl')
      await copyFile(REPLAY_FIXTURE, replayFile)
      const hangKill = setTimeout(() => {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 120_000)
      const { exitCode, captured } = await launchInstalledApp(
        home,
        ['--record-native-window', '--smoke-replay', replayFile],
        { DSH_DESKTOP_FRAMES_DIR: framesDir },
      )
      clearTimeout(hangKill)

      expect(exitCode, `native recording exited ${String(exitCode)}; output:\n${captured.slice(0, 8000)}`).toBe(0)
      for (const marker of ['SMOKE_OK session', 'SMOKE_OK terminal', 'SMOKE_OK quit']) {
        expect(captured, `recording output must carry ${marker}`).toContain(marker)
      }
      const line = captured.split('\n').find(value => value.startsWith('NATIVE_WINDOW_RECORDING '))
      expect(line).toBeDefined()
      const state = JSON.parse(line!.slice('NATIVE_WINDOW_RECORDING '.length)) as {
        framesDir: string
        frames: string[]
        focus: string[]
        window: {
          initialBounds: { x: number; y: number; width: number; height: number }
          dragAttemptBounds: { x: number; y: number; width: number; height: number }
          controlBounds: { x: number; y: number; width: number; height: number }
          minimized: boolean
          restored: boolean
        }
        keyboard: { activeElement: string; value: string }
        scenarioFailure: string | null
      }
      expect(state.scenarioFailure).toBeNull()
      expect(captured).not.toContain('UnhandledPromiseRejectionWarning')
      expect(captured).not.toContain('Object has been destroyed')
      expect(state.framesDir).toBe(framesDir)
      expect(state.focus.slice(0, 3)).toEqual(['active', 'inactive', 'active'])
      expect(state.window.minimized).toBe(true)
      expect(state.window.restored).toBe(true)
      expect(state.keyboard).toEqual({ activeElement: 'TEXTAREA', value: 'KEYBOARD_OK' })
      // Synthetic drag input cannot move a native window without OS pointer
      // permissions; the frames and computed regions carry the product claim.
      expect(state.window.dragAttemptBounds).toEqual(state.window.initialBounds)
      expect(state.window.controlBounds).toEqual(state.window.initialBounds)
      for (const label of [
        'launch', 'inactive', 'active', 'drag-strip-attempt', 'keyboard-typed',
        'restored', 'appearance-dark', 'appearance-light', 'tracer-turn', 'tracer-settled',
      ]) {
        expect(state.frames.some(name => name.includes(`-${label}.png`)), `frames must include ${label}`).toBe(true)
      }
      // Verify the world, not the self-report: the recorded frames exist as
      // real non-empty PNG files on disk.
      for (const name of state.frames) {
        const path = join(framesDir, name)
        expect(existsSync(path), `frame ${name} exists on disk`).toBe(true)
        expect(statSync(path).size, `frame ${name} is a non-empty PNG`).toBeGreaterThan(100)
      }
      child = undefined
    },
    300_000,
  )

  it.skipIf(process.platform !== 'darwin' || !existsSync(APP_BINARY))(
    'records native folder selection, path opening, and an actionable failure through the installed renderer',
    async () => {
      home = await mkdtemp(join(tmpdir(), 'dsh-desktop-native-actions-'))
      const framesDir = join(REPO_ROOT, '.playwright-mcp', 'gif-frames-issue8-native-actions')
      await rm(framesDir, { recursive: true, force: true })
      const hangKill = setTimeout(() => {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 180_000)
      const { exitCode, captured } = await launchInstalledApp(
        home,
        ['--record-native-actions'],
        { DSH_DESKTOP_FRAMES_DIR: framesDir },
      )
      clearTimeout(hangKill)

      expect(exitCode, `native-actions recording exited ${String(exitCode)}; output:\n${captured.slice(0, 8000)}`).toBe(0)
      for (const marker of [
        'SMOKE_OK native-directory',
        'SMOKE_OK native-open',
        'SMOKE_OK native-failure',
        'SMOKE_OK quit',
      ]) {
        expect(captured, `native-actions output must carry ${marker}`).toContain(marker)
      }
      const line = captured.split('\n').find(value => value.startsWith('NATIVE_ACTIONS_RECORDING '))
      expect(line).toBeDefined()
      const state = JSON.parse(line!.slice('NATIVE_ACTIONS_RECORDING '.length)) as {
        framesDir: string
        frames: string[]
        workspace: { path: string; workspaceId: string; sessionId: string; visible: boolean }
        picked: string[]
        opened: string[]
        failures: Array<{ path: string; message: string }>
        success: { ok: boolean; value?: { opened?: boolean } }
        failure: { ok: boolean; error?: { code?: string; message?: string } }
      }
      const workspacePath = join(home, 'native-actions-workspace')
      const openedPath = join(workspacePath, 'opened.txt')
      const missingPath = join(workspacePath, 'missing.txt')
      expect(state.framesDir).toBe(framesDir)
      expect(state.workspace).toMatchObject({ path: workspacePath, visible: true })
      expect(state.workspace.workspaceId).not.toBe('')
      expect(state.workspace.sessionId).not.toBe('')
      expect(state.picked).toEqual([workspacePath])
      expect(state.opened).toEqual([openedPath])
      expect(state.failures).toEqual([{
        path: missingPath,
        message: `path is unavailable: ${missingPath}`,
      }])
      expect(state.success).toEqual({ ok: true, value: { opened: true } })
      expect(state.failure.ok).toBe(false)
      expect(state.failure.error?.code).toBe('internal')
      expect(state.failure.error?.message).toContain(`path is unavailable: ${missingPath}`)
      for (const label of ['directory-picked', 'path-opened', 'path-failure']) {
        expect(state.frames.some(name => name.includes(`-${label}.png`)), `frames must include ${label}`).toBe(true)
      }
      for (const name of state.frames) {
        const path = join(framesDir, name)
        expect(existsSync(path), `frame ${name} exists on disk`).toBe(true)
        expect(statSync(path).size, `frame ${name} is a non-empty PNG`).toBeGreaterThan(100)
      }
      expect(captured).not.toContain('UnhandledPromiseRejectionWarning')
      expect(captured).not.toContain('Object has been destroyed')
      assertNoSurvivors()
      child = undefined
    },
    240_000,
  )

  it.skipIf(process.platform !== 'darwin' || !existsSync(APP_BINARY))(
    'records truthful recovery frames from the failed state through a recovered Session',
    async () => {
      home = await mkdtemp(join(tmpdir(), 'dsh-desktop-packaged-recovery-'))
      const framesDir = join(REPO_ROOT, '.playwright-mcp', 'gif-frames-issue7-recovery')
      // One storyboard is one evidence run: start from a fresh frame root.
      await rm(framesDir, { recursive: true, force: true })
      const replayFile = join(home, 'replay.jsonl')
      await copyFile(REPLAY_FIXTURE, replayFile)
      const hangKill = setTimeout(() => {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 300_000)
      const { exitCode, captured } = await launchInstalledApp(
        home,
        ['--record-recovery', '--smoke-replay', replayFile],
        {
          DSH_DESKTOP_FRAMES_DIR: framesDir,
          DSH_DESKTOP_STARTUP_TIMEOUT_MS: '20000',
        },
      )
      clearTimeout(hangKill)

      expect(exitCode, `recovery recording exited ${String(exitCode)}; output:\n${captured.slice(0, 8000)}`).toBe(0)
      for (const marker of [
        'SMOKE_OK recovery-failed-state',
        'SMOKE_OK recovery-restart',
        'SMOKE_OK session',
        'SMOKE_OK terminal',
        'SMOKE_OK quit',
      ]) {
        expect(captured, `recovery recording output must carry ${marker}`).toContain(marker)
      }
      const line = captured.split('\n').find(value => value.startsWith('RECOVERY_RECORDING '))
      expect(line).toBeDefined()
      const state = JSON.parse(line!.slice('RECOVERY_RECORDING '.length)) as {
        framesDir: string
        frames: string[]
        phases: string[]
        failure: { kind: string | null; message: string | null; detail: string | null }
        keyboard: { activeElement: string; value: string }
        scenarioFailure: string | null
      }
      expect(state.scenarioFailure).toBeNull()
      expect(state.failure.kind).toBe('startup-failed')
      expect(state.framesDir).toBe(framesDir)
      expect(captured).not.toContain('UnhandledPromiseRejectionWarning')
      expect(captured).not.toContain('Object has been destroyed')
      for (const label of ['startup-failed', 'restarting', 'session-recovered', 'tracer-settled']) {
        expect(state.frames.some(name => name.includes(`-${label}.png`)), `frames must include ${label}`).toBe(true)
      }
      // Verify the world, not the self-report: the recorded frames exist as
      // real non-empty PNG files on disk.
      for (const name of state.frames) {
        const path = join(framesDir, name)
        expect(existsSync(path), `frame ${name} exists on disk`).toBe(true)
        expect(statSync(path).size, `frame ${name} is a non-empty PNG`).toBeGreaterThan(100)
      }
      assertNoSurvivors()
      child = undefined
    },
    300_000,
  )

  it.skipIf(process.platform !== 'darwin' || !existsSync(APP_BINARY))(
    'runs the keyless tracer bullet on the installed bundle and quits quiescent',
    async () => {
      home = await mkdtemp(join(tmpdir(), 'dsh-desktop-packaged-'))
      const replayFile = join(home, 'replay.jsonl')
      await copyFile(REPLAY_FIXTURE, replayFile)

      const { exitCode, captured } = await launchInstalledApp(home, ['--smoke', '--smoke-replay', replayFile])

      expect(exitCode, `packaged smoke exited ${String(exitCode)}; output:\n${captured.slice(0, 4000)}`).toBe(0)
      for (const marker of ['SMOKE_OK ready', 'SMOKE_OK no-tcp-listener', 'SMOKE_OK session', 'SMOKE_OK terminal', 'SMOKE_OK quit', 'SMOKE_PASS']) {
        expect(captured, `packaged smoke output must carry ${marker}`).toContain(marker)
      }
      expect(captured).not.toContain('desktop smoke failed')
      expect(captured).not.toContain('desktop app failed to start')

      // Quit-cleanup: neither the application nor its DSH child (the same
      // binary running as Node) survives the terminate-and-join shutdown.
      assertNoSurvivors()
      child = undefined
    },
    300_000,
  )

  it.skipIf(process.platform !== 'darwin' || !existsSync(APP_BINARY))(
    'exits non-zero and quiescent when the smoke scenario fails',
    async () => {
      home = await mkdtemp(join(tmpdir(), 'dsh-desktop-packaged-'))
      // A replay path whose parent directory does not exist must fail the
      // keyless scenario — and the owned process tree must still terminate.
      const missingReplay = join(home, 'no-such-dir', 'replay.jsonl')
      const hangKill = setTimeout(() => {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 120_000)

      const { exitCode, captured } = await launchInstalledApp(home, ['--smoke', '--smoke-replay', missingReplay])
      clearTimeout(hangKill)

      expect(exitCode, `failed smoke must exit with the scenario verdict; output:\n${captured.slice(0, 4000)}`).toBe(1)
      expect(captured).toContain('desktop smoke failed')
      // Failure-path quiescence: terminate-and-join still empties the tree.
      assertNoSurvivors()
      child = undefined
    },
    180_000,
  )
})
