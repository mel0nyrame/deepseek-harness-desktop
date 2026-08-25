import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DshSupervisor,
  type DshChild,
  type DshSpawnOptions,
  type SpawnDshChild,
} from '../apps/desktop/src/supervisor.js'

const ROOT = resolve(import.meta.dirname, '..')
const FIXTURES = resolve(ROOT, 'tests', 'fixtures')

interface FixtureInfo {
  readonly pid: number
  readonly grandchild?: number
  readonly pty?: number
}

interface FixtureRun {
  readonly helper: ChildProcess
  readonly supervisor: DshSupervisor
  readonly info: FixtureInfo
  readonly ownedPids: readonly number[]
  readonly home: string
}

function isRunning(pid: number): boolean {
  try {
    const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
    }).trim()
    return state !== '' && !state.startsWith('Z')
  } catch {
    return false
  }
}

function spawnOptions(home: string): DshSpawnOptions {
  return {
    executable: process.execPath,
    cliEntry: resolve(FIXTURES, 'process-tree-readiness.mjs'),
    runtimeRoot: ROOT,
    home,
  }
}

async function launchFixture(
  name: string,
  shutdownTimeoutMs = 500,
  treeSnapshotMs = 25,
): Promise<FixtureRun> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-process-tree-'))
  let helper: ChildProcess | undefined
  let resolveInfo!: (info: FixtureInfo) => void
  let rejectInfo!: (error: Error) => void
  const infoPromise = new Promise<FixtureInfo>((resolveValue, rejectValue) => {
    resolveInfo = resolveValue
    rejectInfo = rejectValue
  })
  const spawnChild: SpawnDshChild = () => {
    helper = fork(resolve(FIXTURES, `process-tree-${name}.mjs`), [], {
      cwd: ROOT,
      detached: true,
      env: { ...process.env, DSH_HOME: home },
      serialization: 'json',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let stdout = ''
    const timer = setTimeout(() => {
      rejectInfo(new Error(`process-tree fixture ${name} did not report its pids`))
    }, 10_000)
    helper.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
      const line = stdout.split('\n').find(candidate => candidate.startsWith('{'))
      if (line === undefined) return
      clearTimeout(timer)
      try {
        resolveInfo(JSON.parse(line) as FixtureInfo)
      } catch (error) {
        rejectInfo(error instanceof Error ? error : new Error(String(error)))
      }
    })
    helper.stderr?.on('data', () => {})
    return helper as DshChild
  }
  const supervisor = new DshSupervisor(spawnChild, {
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs,
    treeGraceMs: 500,
    treeSnapshotMs,
  })
  try {
    await supervisor.start(spawnOptions(home))
    const info = await infoPromise
    if (helper === undefined) throw new Error('process-tree fixture did not spawn')
    const ownedPids = [
      info.pid,
      ...(info.grandchild === undefined ? [] : [info.grandchild]),
      ...(info.pty === undefined ? [] : [info.pty]),
    ]
    return { helper, supervisor, info, ownedPids, home }
  } catch (error) {
    await supervisor.stop().catch(() => {})
    if (helper?.pid !== undefined && isRunning(helper.pid)) {
      try {
        process.kill(-helper.pid, 'SIGKILL')
      } catch {
        // The fixture group already emptied.
      }
    }
    rmSync(home, { recursive: true, force: true })
    throw error
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`fixture process ${String(child.pid)} did not exit`))
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveWait()
    })
  })
}

describe.skipIf(process.platform !== 'darwin')('desktop macOS process-tree cleanup', () => {
  let run: FixtureRun | undefined

  afterEach(async () => {
    if (run === undefined) return
    for (const pid of run.ownedPids) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL')
        } catch {
          // The owned process or group already emptied.
        }
      }
    }
    await waitForExit(run.helper).catch(() => {})
    rmSync(run.home, { recursive: true, force: true })
    run = undefined
  })

  it('terminates a graceful child and its reparented descendant', async () => {
    run = await launchFixture('graceful')
    expect(isRunning(run.info.grandchild as number)).toBe(true)

    await run.supervisor.stop()

    expect(run.helper.exitCode).toBe(0)
    expect(isRunning(run.info.grandchild as number)).toBe(false)
  }, 30_000)

  it('escalates when the process tree ignores SIGTERM', async () => {
    run = await launchFixture('stubborn')
    expect(isRunning(run.info.grandchild as number)).toBe(true)

    await run.supervisor.stop()

    expect(run.helper.signalCode).toBe('SIGKILL')
    expect(isRunning(run.info.grandchild as number)).toBe(false)
  }, 30_000)

  it('sweeps a reparented descendant after an unexpected root exit', async () => {
    run = await launchFixture('orphan')
    const exit = run.supervisor.nextUnexpectedExit()
    expect(isRunning(run.info.grandchild as number)).toBe(true)

    await expect(exit).resolves.toEqual({ code: 0, signal: null })

    expect(isRunning(run.info.grandchild as number)).toBe(false)
  }, 30_000)

  it('cleans up a real PTY session after forced root termination', async () => {
    run = await launchFixture('pty')
    expect(isRunning(run.info.pty as number)).toBe(true)

    await run.supervisor.stop()

    expect(run.helper.signalCode).toBe('SIGKILL')
    expect(isRunning(run.info.pty as number)).toBe(false)
  }, 30_000)

  it('recovers a distinct-group PTY from the pre-exit snapshot', async () => {
    run = await launchFixture('pty-orphan')
    const exit = run.supervisor.nextUnexpectedExit()
    expect(isRunning(run.info.pty as number)).toBe(true)

    await expect(exit).resolves.toEqual({ code: 0, signal: null })

    expect(isRunning(run.info.pty as number)).toBe(false)
  }, 30_000)
})
