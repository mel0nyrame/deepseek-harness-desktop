import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeRuntimeOutput, scrubRuntimeEnvironment } from '../scripts/runtime-output.js'
import {
  liveProcessIdentities,
  processIdentities,
  textOutput,
  type ProcessOutput,
} from './desktop-process-evidence.js'
import { assertOfficialUiEvidence, type UiEvidence } from './desktop-ui-evidence-contract.js'

const ROOT = resolve(import.meta.dirname, '..')
const RUNTIME = join(ROOT, '.artifacts', 'runtime-e2e')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'terminal-turn', 'session.jsonl')
const VISUAL_FIXTURES = [1, 2, 3]
  .map(index => join(ROOT, 'tests', 'fixtures', 'visual-acceptance', `session-${String(index)}.jsonl`))
const temporaryDirectories = new Set<string>()

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

function electronExecutable(): string {
  const packageRoot = join(ROOT, 'apps', 'desktop', 'node_modules', 'electron')
  const pathFile = join(packageRoot, 'path.txt')
  if (!existsSync(pathFile)) {
    execFileSync(process.execPath, [join(packageRoot, 'install.js')], { cwd: ROOT })
  }
  const relative = readFileSync(pathFile, 'utf8').trim()
  return join(packageRoot, 'dist', relative)
}

function launch(home: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = {
    ...scrubRuntimeEnvironment(process.env),
    DSH_HOME: home,
    DSH_DESKTOP_RUNTIME_ROOT: RUNTIME,
    DSH_DESKTOP_PROCESS_EVIDENCE: '1',
  }
  // This test launches the real Electron app, not an ELECTRON_RUN_AS_NODE child.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DSH_DESKTOP_REQUIRE_OS_DRAG
  return spawnSync(electronExecutable(), [RUNTIME, ...args], {
    cwd: home,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  })
}

function accessibilityAutomationAvailable(): boolean {
  return execFileSync('/usr/bin/swift', [
    '-e',
    'import ApplicationServices; print(AXIsProcessTrusted())',
  ], { encoding: 'utf8' }).trim() === 'true'
}

function postOsPointerDrag(point: { readonly x: number; readonly y: number }): void {
  const finish = { x: point.x + 40, y: point.y + 40 }
  const swift = `
import CoreGraphics
import Foundation
let start = CGPoint(x: ${String(point.x)}, y: ${String(point.y)})
let finish = CGPoint(x: ${String(finish.x)}, y: ${String(finish.y)})
CGWarpMouseCursorPosition(start)
Thread.sleep(forTimeInterval: 0.1)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
for step in 1...12 {
  let fraction = CGFloat(step) / 12
  let point = CGPoint(x: start.x + (finish.x - start.x) * fraction, y: start.y + (finish.y - start.y) * fraction)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
  Thread.sleep(forTimeInterval: 0.02)
}
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: finish, mouseButton: .left)?.post(tap: .cghidEventTap)
`
  execFileSync('/usr/bin/swift', ['-e', swift], { stdio: 'pipe' })
}

interface InteractiveLaunchResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error
}

async function launchWithOsDrag(home: string, args: readonly string[]): Promise<InteractiveLaunchResult> {
  const env: NodeJS.ProcessEnv = {
    ...scrubRuntimeEnvironment(process.env),
    DSH_HOME: home,
    DSH_DESKTOP_RUNTIME_ROOT: RUNTIME,
    DSH_DESKTOP_PROCESS_EVIDENCE: '1',
    DSH_DESKTOP_REQUIRE_OS_DRAG: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronExecutable(), [RUNTIME, ...args], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let pendingLine = ''
  let pointerTask = Promise.resolve()
  let pointerError: Error | undefined
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    stdout += text
    const lines = `${pendingLine}${text}`.split('\n')
    pendingLine = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('NATIVE_WINDOW_DRAG_READY ')) continue
      const payload = JSON.parse(line.slice('NATIVE_WINDOW_DRAG_READY '.length)) as {
        point?: { x?: unknown; y?: unknown }
      }
      const { x, y } = payload.point ?? {}
      if (typeof x !== 'number' || !Number.isFinite(x)
        || typeof y !== 'number' || !Number.isFinite(y)) {
        pointerError = new Error(`invalid native drag target: ${line}`)
        child.kill('SIGTERM')
        continue
      }
      pointerTask = pointerTask.then(() => { postOsPointerDrag({ x, y }) }).catch((error: unknown) => {
        pointerError = error instanceof Error ? error : new Error(String(error))
        child.kill('SIGTERM')
      })
    }
  })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const timeout = setTimeout(() => { child.kill('SIGKILL') }, 180_000)
  return await new Promise<InteractiveLaunchResult>((resolveLaunch) => {
    child.once('error', (error) => {
      clearTimeout(timeout)
      resolveLaunch({ status: null, stdout, stderr, error })
    })
    child.once('close', (status) => {
      clearTimeout(timeout)
      void pointerTask.finally(() => {
        resolveLaunch({
          status,
          stdout,
          stderr,
          ...(pointerError === undefined ? {} : { error: pointerError }),
        })
      })
    })
  })
}

function expectQuiescent(result: ProcessOutput, minimumIdentities = 1): void {
  const identities = processIdentities(result)
  expect(identities.length).toBeGreaterThanOrEqual(minimumIdentities)
  expect(liveProcessIdentities(identities)).toEqual([])
}

beforeAll(() => {
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'assemble-runtime.ts'), '--output', RUNTIME,
  ], {
    cwd: ROOT,
    env: { ...scrubRuntimeEnvironment(process.env), CI: 'true' },
    stdio: 'pipe',
  })
}, 120_000)

afterAll(() => {
  removeRuntimeOutput(RUNTIME)
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'darwin')('integrated Electron runtime', () => {
  it('composes the official Client with desktop workspace, input, conversation, and settings contributions', () => {
    const home = temporary('dsh-desktop-ui-home-')
    const workspaceRoot = temporary('dsh-desktop-ui-workspace-')
    const picked = join(workspaceRoot, 'deepseek-harness')
    mkdirSync(picked)
    const frames = temporary('dsh-desktop-ui-frames-')

    const result = launch(home, [
      `--user-data-dir=${join(home, 'electron-user-data')}`,
      '--lang=en-US',
      '--tracer-ui', picked,
      '--replay-file', VISUAL_FIXTURES[0] as string,
      '--replay-child-file', VISUAL_FIXTURES[1] as string,
      '--replay-child-file', VISUAL_FIXTURES[2] as string,
      '--replay-child-file', FIXTURE,
      '--frames-dir', frames,
    ])

    expect(result.error).toBeUndefined()
    expect(result.status, textOutput(result.stderr)).toBe(0)
    const output = textOutput(result.stdout)
    expect(output).toContain('TRACER_OK no-loopback-listener')
    expect(output).toContain('TRACER_OK official-client-ui')
    const evidenceLine = output.split('\n')
      .find(line => line.startsWith('DESKTOP_UI_EVIDENCE '))
    expect(evidenceLine).toBeDefined()
    const evidence = JSON.parse(
      (evidenceLine as string).slice('DESKTOP_UI_EVIDENCE '.length),
    ) as UiEvidence
    assertOfficialUiEvidence(evidence, frames, picked)
    for (const id of [
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-directory-picker-native',
      '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-workspace',
      '@dsh-desktop/ui',
    ]) expect(evidence.graph).toContain(id)
    expect(JSON.parse(readFileSync(join(frames, 'evidence.json'), 'utf8'))).toEqual(evidence)
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8'))
      .toContain('ui-sidebar-glass-macos:\n  enabled: false')
    expectQuiescent(result)
  }, 180_000)

  it('renders one ordered keyless terminal turn over the real embedded DSH child', () => {
    const home = temporary('dsh-desktop-e2e-home-')
    const frames = temporary('dsh-desktop-e2e-frames-')

    const result = launch(home, ['--tracer', '--replay-file', FIXTURE, '--frames-dir', frames])

    expect(result.error).toBeUndefined()
    expect(result.status, textOutput(result.stderr)).toBe(0)
    expect(textOutput(result.stdout)).toContain('TRACER_OK no-loopback-listener')
    expect(textOutput(result.stdout)).toContain('TRACER_LAYOUT centered-system-status')
    expect(textOutput(result.stdout)).toContain('NATIVE_WINDOW_EVIDENCE ')
    expect(textOutput(result.stdout)).toContain('TRACER_STATE complete')
    expect(textOutput(result.stdout)).toMatch(/TRACER_VISIBLE terminal-result \d+ bright pixel/)
    expect(textOutput(result.stdout)).toContain('TRACER_OK terminal-session')
    const completed = readdirSync(frames).find(file => file.endsWith('-complete.png'))
    expect(completed).toBeDefined()
    const png = readFileSync(join(frames, completed as string))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    expect(width).toBeGreaterThanOrEqual(900)
    expect(height).toBeGreaterThanOrEqual(640)
    expect(png.byteLength).toBeGreaterThan(20_000)
    const nativeFrames = ['native-dark.png', 'native-light.png', 'native-system.png']
      .map(file => readFileSync(join(frames, file)))
    expect(nativeFrames.every(frame => frame.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')).toBe(true)
    expect(nativeFrames[0]?.equals(nativeFrames[1] as Buffer)).toBe(false)
    const evidenceLine = textOutput(result.stdout).split('\n')
      .find(line => line.startsWith('NATIVE_WINDOW_EVIDENCE '))
    expect(evidenceLine).toBeDefined()
    const evidence = JSON.parse((evidenceLine as string).slice('NATIVE_WINDOW_EVIDENCE '.length)) as {
      focusTransitions?: string[]
      dragRegion?: string
      controlRegion?: string
      resized?: boolean
    }
    expect(evidence).toMatchObject({
      focusTransitions: ['active', 'inactive', 'active'],
      dragRegion: 'drag',
      controlRegion: 'no-drag',
      resized: true,
    })
    expectQuiescent(result)
  }, 180_000)

  it.runIf(process.env['DSH_DESKTOP_REQUIRE_OS_DRAG'] === '1')(
    'moves only the computed drag surface under externally injected OS pointer events',
    async () => {
      expect(accessibilityAutomationAvailable()).toBe(true)
      const home = temporary('dsh-desktop-os-drag-home-')
      const frames = temporary('dsh-desktop-os-drag-frames-')
      const result = await launchWithOsDrag(home, [
        '--tracer', '--replay-file', FIXTURE, '--frames-dir', frames,
      ])

      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('NATIVE_WINDOW_DRAG_STAGE {"stage":"drag"')
      expect(result.stdout).toContain('NATIVE_WINDOW_DRAG_STAGE {"stage":"control"')
      const evidenceLine = result.stdout.split('\n')
        .find(line => line.startsWith('NATIVE_WINDOW_EVIDENCE '))
      expect(evidenceLine).toBeDefined()
      const evidence = JSON.parse((evidenceLine as string).slice('NATIVE_WINDOW_EVIDENCE '.length))
      expect(evidence).toMatchObject({ osDragMoved: true, osControlMoved: false })
      expectQuiescent(result)
    },
    180_000,
  )

  it('adopts a directory and opens a path through the full native reverse-request journey', () => {
    const home = temporary('dsh-desktop-native-home-')
    const picked = temporary('dsh-desktop-native-picked-')
    const frames = temporary('dsh-desktop-native-frames-')

    const result = launch(home, [
      '--tracer-native', picked,
      '--tracer-open-path', picked,
      '--frames-dir', frames,
    ])

    expect(result.error).toBeUndefined()
    expect(result.status, textOutput(result.stderr)).toBe(0)
    expect(textOutput(result.stdout)).toContain('DESKTOP_CHILD_PID ')
    expect(textOutput(result.stdout)).toContain('TRACER_OK no-loopback-listener')
    expect(textOutput(result.stdout)).toContain('TRACER_LAYOUT centered-system-status')
    expect(textOutput(result.stdout)).toContain('NATIVE_WINDOW_EVIDENCE ')
    for (const state of ['starting', 'picked', 'opening', 'complete']) {
      expect(textOutput(result.stdout)).toContain(`TRACER_STATE ${state}`)
    }
    expect(textOutput(result.stdout)).toMatch(/TRACER_VISIBLE terminal-result \d+ bright pixel/)
    const completed = readdirSync(frames).find(file => file.endsWith('-complete.png'))
    expect(completed).toBeDefined()
    expectQuiescent(result)
  }, 120_000)

  it('joins a child when Electron quits during startup', () => {
    const home = temporary('dsh-desktop-startup-quit-')

    const result = launch(home, ['--quit-during-startup'])

    expect(result.error).toBeUndefined()
    expect(result.status, textOutput(result.stderr)).toBe(0)
    expectQuiescent(result)
  }, 30_000)

  it('restarts once after configuration failure and leaves no owned process', () => {
    const home = temporary('dsh-desktop-config-failure-')
    const profile = join(home, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'cordis.patch.yml'), '- insert: [not valid yaml\n  trailing:')

    const result = launch(home, [])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(textOutput(result.stderr)).toContain('initial child generation failed; restarting once')
    expect(textOutput(result.stderr)).toContain('startup failed')
    expectQuiescent(result, 2)
  }, 30_000)
})
