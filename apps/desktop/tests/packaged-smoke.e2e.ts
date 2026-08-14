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
import { existsSync, readdirSync } from 'node:fs'
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
  async function launchInstalledApp(homeDir: string, args: string[]): Promise<{ exitCode: number | null; captured: string }> {
    const env = { ...process.env }
    // The application binary must launch as an app, not as a Node runtime.
    delete env['ELECTRON_RUN_AS_NODE']
    delete env['DSH_NODE_EXECUTABLE']
    Object.assign(env, {
      DSH_HOME: homeDir,
      DSH_AGENTS_HOME: join(homeDir, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'keyless-desktop-no-call',
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
