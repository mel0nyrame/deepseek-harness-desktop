/**
 * Real macOS process-tree acceptance for the terminate-and-join ladder. Each
 * scenario forks a real fixture process tree (`detached`, so it leads its own
 * process group, exactly like the product's DSH child) and drives it through
 * {@link DshSupervisor} with the real `/bin/ps` ladder:
 *
 * - graceful termination sweeps a reparented descendant of a child that exited 0;
 * - forced escalation SIGKILLs a SIGTERM-immune tree after the bounded grace;
 * - a descendant that outlived its immediate parent is still identified and
 *   terminated through its process group;
 * - a real node-pty session is cleaned up when its owning process is killed;
 * - a distinct-group PTY whose owner died without cleanup is recovered from the
 *   supervisor's pre-exit ownership snapshot.
 *
 * Mocks cannot prove any of these claims, so this suite runs on darwin only.
 */

import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DshSupervisor, type DshChild } from '../src/supervisor.ts'
import { createProcessTreeLadder } from '../src/process-tree.ts'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))

interface FixtureInfo {
  readonly pid: number
  readonly grandchild?: number
  readonly pty?: number
}

interface FixtureRun {
  readonly helper: ChildProcess
  readonly supervisor: DshSupervisor
  readonly info: FixtureInfo
  readonly ownedPids: number[]
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, `${name}.mjs`)
}

async function launchFixture(name: string, shutdownTimeoutMs = 5_000, treeSnapshotMs = 100): Promise<FixtureRun> {
  const helper = fork(fixturePath(name), [], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
  })
  const info = await new Promise<FixtureInfo>((resolveInfo, reject) => {
    let buffer = ''
    const deadline = setTimeout(() => {
      reject(new Error(`fixture ${name} never reported its pids`))
    }, 10_000)
    helper.stdout?.on('data', (chunk: Buffer) => {
      buffer += String(chunk)
      const line = buffer.split('\n').find(candidate => candidate.startsWith('{'))
      if (line === undefined) return
      clearTimeout(deadline)
      try {
        resolveInfo(JSON.parse(line) as FixtureInfo)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
  helper.stderr?.on('data', () => {})
  const tree = createProcessTreeLadder()
  const supervisor = new DshSupervisor(helper as unknown as DshChild, {
    shutdownTimeoutMs,
    treeGraceMs: 2_000,
    treeSnapshotMs,
    ...(tree === undefined ? {} : { tree }),
  })
  const ownedPids = [info.pid, ...(info.grandchild === undefined ? [] : [info.grandchild]), ...(info.pty === undefined ? [] : [info.pty])]
  return { helper, supervisor, info, ownedPids }
}

async function waitForHelperExit(helper: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (helper.exitCode !== null || helper.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`fixture process ${String(helper.pid)} did not exit within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    helper.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

describe.skipIf(process.platform !== 'darwin')('desktop macOS process-tree ladder', () => {
  let run: FixtureRun | undefined

  afterEach(async () => {
    if (run === undefined) return
    // Belt and braces: never leave a fixture tree behind, even on assertion
    // failure. SIGKILL every owned pid's process group (PTY sessions lead
    // their own group, so the helper's group alone would not reach them).
    for (const pid of run.ownedPids) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // The group already emptied.
      }
    }
    if (run.helper.exitCode === null && run.helper.signalCode === null) {
      await waitForHelperExit(run.helper).catch((waitError: unknown) => {
        // The group SIGKILL above may already have ended the helper; this
        // wait is best-effort because the next cleanup step resets run.
        console.error('desktop process-tree cleanup wait failed:', waitError)
      })
    }
    run = undefined
  })

  it('terminates a graceful child and sweeps its reparented descendant', async () => {
    run = await launchFixture('graceful-child')
    const { helper, supervisor, info } = run
    expect(info.grandchild).toBeDefined()
    expect(isAlive(info.grandchild!)).toBe(true)

    await supervisor.stop()

    expect(helper.exitCode).toBe(0)
    expect(supervisor.wasEscalated).toBe(false)
    expect(isAlive(info.grandchild!)).toBe(false)
  }, 60_000)

  it('escalates to SIGKILL when the tree ignores SIGTERM', async () => {
    run = await launchFixture('stubborn-child')
    const { helper, supervisor, info } = run
    expect(isAlive(info.grandchild!)).toBe(true)

    await supervisor.stop()

    expect(supervisor.wasEscalated).toBe(true)
    expect(helper.signalCode).toBe('SIGKILL')
    expect(isAlive(info.grandchild!)).toBe(false)
  }, 60_000)

  it('terminates a descendant that outlived its immediate parent', async () => {
    run = await launchFixture('orphan-maker')
    const { helper, supervisor, info } = run
    expect(info.grandchild).toBeDefined()
    // The fixture exits on its own; the grandchild is reparented and only the
    // process group still identifies it as owned.
    await waitForHelperExit(helper)
    expect(isAlive(info.grandchild!)).toBe(true)

    await supervisor.stop()

    expect(isAlive(info.grandchild!)).toBe(false)
  }, 60_000)

  it('cleans up a real PTY session when its owner is force-killed', async () => {
    run = await launchFixture('pty-child')
    const { supervisor, info } = run
    expect(info.pty).toBeDefined()
    expect(isAlive(info.pty!)).toBe(true)

    await supervisor.stop()

    expect(supervisor.wasEscalated).toBe(true)
    expect(isAlive(info.pty!)).toBe(false)
  }, 60_000)

  it('recovers a distinct-group PTY from the pre-exit snapshot after its owner dies', async () => {
    run = await launchFixture('pty-orphan', 5_000, 25)
    const { helper, supervisor, info } = run
    expect(info.pty).toBeDefined()
    expect(isAlive(info.pty!)).toBe(true)
    // The fixture exits without cleanup; after that point the PTY is
    // reparented into its own group and only the pre-exit snapshot owns it.
    await waitForHelperExit(helper)
    expect(isAlive(info.pty!)).toBe(true)

    await supervisor.stop()

    expect(isAlive(info.pty!)).toBe(false)
  }, 60_000)
})
