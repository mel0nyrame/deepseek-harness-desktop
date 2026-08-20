/**
 * DesktopLifecycle state-machine coverage: every acceptance-criterion outcome
 * (startup success, startup timeout, configuration failure, unexpected exit,
 * quit during startup) plus the one controlled restart, the single shutdown
 * owner, and actionable cleanup-incomplete reporting — over fake children, so
 * no process participates.
 */

import { describe, expect, it, vi } from 'vitest'
import type { DesktopChildMessage } from '@deepseek-ai/dsh-desktop-app'
import { DesktopLifecycle, type HostFailure, type HostPhase } from '../src/lifecycle.ts'
import { DshSupervisor } from '../src/supervisor.ts'
import type { ProcessTreeEntry, ProcessTreeLadder, ProcessTreeSnapshot } from '../src/process-tree.ts'
import { FakeChild } from './fixtures/fake-child.ts'

interface Harness {
  readonly lifecycle: DesktopLifecycle
  readonly children: FakeChild[]
  readonly supervisors: DshSupervisor[]
  readonly phases: HostPhase[]
  readonly failures: HostFailure[]
}

function createHarness(options: { stderr?: string; tree?: ProcessTreeLadder; treeGraceMs?: number } = {}): Harness {
  const children: FakeChild[] = []
  const supervisors: DshSupervisor[] = []
  const phases: HostPhase[] = []
  const failures: HostFailure[] = []
  const stderrTails: string[] = []
  const lifecycle = new DesktopLifecycle({
    spawn: () => {
      const child = new FakeChild()
      if (options.tree !== undefined) child.pid = 400
      const supervisor = new DshSupervisor(child, {
        startupTimeoutMs: 100,
        shutdownTimeoutMs: 50,
        ...(options.tree === undefined ? {} : { tree: options.tree }),
        ...(options.treeGraceMs === undefined ? {} : { treeGraceMs: options.treeGraceMs }),
      })
      children.push(child)
      supervisors.push(supervisor)
      stderrTails.push(options.stderr ?? '')
      return { supervisor, childPid: child.pid, tail: () => stderrTails.at(-1) ?? '' }
    },
  })
  lifecycle.onPhase((phase) => { phases.push(phase) })
  lifecycle.onFailure((failure) => { failures.push(failure) })
  return { lifecycle, children, supervisors, phases, failures }
}

const READY: DesktopChildMessage = { type: 'ready', graph: { rev: 'one', entries: [] }, bundles: [] }

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** Records process-tree sweeps without owning real processes. */
class RecordingLadder implements ProcessTreeLadder {
  snapshots = 0

  constructor(private readonly owned: readonly ProcessTreeEntry[] = []) {}

  snapshot(rootPid: number): ProcessTreeSnapshot {
    this.snapshots += 1
    return { rootPid, rootPresent: true, owned: [...this.owned] }
  }

  signalGroups(_entries: readonly ProcessTreeEntry[], _signal: 'SIGTERM' | 'SIGKILL'): void {}

  survivors(snapshot: ProcessTreeSnapshot): ProcessTreeEntry[] {
    return [...snapshot.owned]
  }
}

describe('desktop Host lifecycle', () => {
  it('reaches the running phase on a successful startup handshake', async () => {
    const { lifecycle, children } = createHarness()
    const starting = lifecycle.start()
    children[0]!.receive(READY)
    await starting
    expect(lifecycle.phase).toBe('running')
    expect(lifecycle.bootInfo).toMatchObject({ type: 'ready' })
  })

  it('classifies a startup timeout as an actionable failure and cleans the generation up', async () => {
    vi.useFakeTimers()
    try {
      const { lifecycle, children } = createHarness()
      const starting = lifecycle.start()
      const settled = expect(starting).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(250)
      await settled
      expect(lifecycle.phase).toBe('failed')
      expect(lifecycle.failure?.kind).toBe('startup-timeout')
      expect(lifecycle.failure?.message).toContain('did not become ready in time')
      // The hung generation is shut down, not left running.
      expect(children[0]!.killed).toContain('SIGTERM')
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies a configuration failure (exit before ready) with the stderr tail', async () => {
    const { lifecycle, children, failures } = createHarness({ stderr: 'YAMLException: bad indentation in cordis.patch.yml' })
    const starting = lifecycle.start()
    await flush()
    children[0]!.exit(1)
    await starting
    expect(lifecycle.phase).toBe('failed')
    expect(lifecycle.failure?.kind).toBe('startup-failed')
    expect(lifecycle.failure?.detail).toContain('cordis.patch.yml')
    expect(failures[0]?.message).toContain('failed to start')
  })

  it('runs one controlled restart after an unexpected exit, then runs again', async () => {
    const { lifecycle, children, phases } = createHarness()
    const starting = lifecycle.start()
    children[0]!.receive(READY)
    await starting
    expect(lifecycle.phase).toBe('running')

    children[0]!.exit(1)
    await flush()
    expect(lifecycle.phase).toBe('recovering')
    expect(children).toHaveLength(2)

    children[1]!.receive(READY)
    await flush()
    expect(lifecycle.phase).toBe('running')
    expect(phases).toContain('recovering')
  })

  it('sweeps the crashed generation tree before booting its replacement', async () => {
    const tree = new RecordingLadder()
    const { lifecycle, children } = createHarness({ tree })
    const starting = lifecycle.start()
    children[0]!.receive(READY)
    await starting

    children[0]!.exit(1)
    await flush()

    expect(tree.snapshots).toBeGreaterThan(0)
    expect(children).toHaveLength(2)
    expect(lifecycle.phase).toBe('recovering')
    children[1]!.receive(READY)
    await flush()
    expect(lifecycle.phase).toBe('running')
  })

  it('blocks restart when the crashed generation tree cannot be cleaned up', async () => {
    vi.useFakeTimers()
    try {
      const survivor = { pid: 401, pgid: 401, started: 'x', command: 'orphan' }
      const tree = new RecordingLadder([survivor])
      const { lifecycle, children } = createHarness({ tree, treeGraceMs: 5 })
      const starting = lifecycle.start()
      children[0]!.receive(READY)
      await starting

      children[0]!.exit(1)
      await vi.advanceTimersByTimeAsync(100)
      await flush()

      expect(lifecycle.phase).toBe('failed')
      expect(lifecycle.failure?.kind).toBe('cleanup-incomplete')
      expect(lifecycle.failure?.survivors).toEqual([{ pid: 401, command: 'orphan' }])
      expect(lifecycle.restartAvailable).toBe(false)
      await expect(lifecycle.restart()).rejects.toThrow(/unavailable after an incomplete cleanup/)
      expect(children).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })


  it('lands in the failed state when the second unexpected exit exhausts restarts', async () => {
    const { lifecycle, children } = createHarness()
    const starting = lifecycle.start()
    children[0]!.receive(READY)
    await starting

    children[0]!.exit(1)
    await flush()
    children[1]!.receive(READY)
    await flush()
    expect(lifecycle.phase).toBe('running')

    children[1]!.exit(1)
    await flush()
    expect(lifecycle.phase).toBe('failed')
    expect(lifecycle.failure?.kind).toBe('unexpected-exit')
    expect(children).toHaveLength(2)
  })

  it('offers manual restart only from the failed state', async () => {
    const { lifecycle, children } = createHarness()
    const starting = lifecycle.start()
    children[0]!.receive(READY)
    await starting
    await expect(lifecycle.restart()).rejects.toThrow(/only available from the failed state/)

    // Exhaust the single automatic restart, then recover manually.
    children[0]!.exit(1)
    await flush()
    children[1]!.receive(READY)
    await flush()
    children[1]!.exit(1)
    await flush()
    expect(lifecycle.phase).toBe('failed')

    const restarting = lifecycle.restart()
    children[2]!.receive(READY)
    await restarting
    expect(lifecycle.phase).toBe('running')
  })

  it('wins the quit race against startup and never enters running', async () => {
    const { lifecycle, children } = createHarness()
    const starting = lifecycle.start()
    const stopping = lifecycle.stop()
    await flush()
    children[0]!.exit(0)
    const report = await stopping
    await starting
    expect(report.quiescent).toBe(true)
    expect(lifecycle.phase).toBe('stopped')
    expect(children[0]!.killed).toContain('SIGTERM')
  })

  it('quits during recovering without spawning a lost generation', async () => {
    const { lifecycle, children } = createHarness()
    const starting = lifecycle.start()
    children[0]!.receive(READY)
    await starting

    children[0]!.exit(1)
    await flush()
    expect(lifecycle.phase).toBe('recovering')
    const stopping = lifecycle.stop()
    await flush()
    children.at(-1)?.exit(0)
    const report = await stopping
    expect(report.quiescent).toBe(true)
    expect(lifecycle.phase).toBe('stopped')
    expect(children.length).toBeLessThanOrEqual(2)
  })

  it('reports a clean normal quit with a quiescent tree', async () => {
    const { lifecycle, children } = createHarness()
    const starting = lifecycle.start()
    children[0]!.receive(READY)
    await starting
    const stopping = lifecycle.stop()
    await flush()
    children[0]!.exit(0)
    const report = await stopping
    expect(report).toEqual({ quiescent: true, escalated: false })
    expect(lifecycle.phase).toBe('stopped')
  })

  it('reports cleanup-incomplete instead of success when the tree survives', async () => {
    vi.useFakeTimers()
    try {
      const { lifecycle, children } = createHarness()
      const starting = lifecycle.start()
      children[0]!.receive(READY)
      await starting

      const stopping = lifecycle.stop()
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(50)
      const report = await stopping
      expect(report.quiescent).toBe(false)
      expect(report.failure?.kind).toBe('cleanup-incomplete')
      expect(report.failure?.message).toContain('did not shut down cleanly')
      expect(lifecycle.phase).toBe('stopped')
    } finally {
      vi.useRealTimers()
    }
  })
})
