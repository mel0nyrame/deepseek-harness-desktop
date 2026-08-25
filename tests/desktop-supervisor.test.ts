import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  DshSupervisor,
  type DshChild,
  type DshSpawnOptions,
} from '../apps/desktop/src/supervisor.js'
import type { DesktopParentMessage } from '../packages/connection/src/protocol.js'
import type {
  ProcessTreeEntry,
  ProcessTreeLadder,
  ProcessTreeSnapshot,
} from '../apps/desktop/src/process-tree.js'

class FakeChild extends EventEmitter implements DshChild {
  readonly pid: number
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []
  readonly messages: DesktopParentMessage[] = []

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.messages.push(message as DesktopParentMessage)
    callback?.(null)
    return this.connected
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    return true
  }

  ready(home = '/tmp/dsh-desktop-supervisor-test'): void {
    const request = this.messages.find(message => message.type === 'request')
    if (request === undefined || request.body === undefined) throw new Error('readiness request was not sent')
    const envelope = JSON.parse(request.body) as { rpcId: string }
    this.emit('message', {
      type: 'response',
      id: request.id,
      status: 200,
      headers: [['content-type', 'application/json']],
      body: JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: {
            version: 'test',
            cwd: '/tmp',
            attachedSessions: 0,
            home,
            canOpenPath: false,
          },
        },
      }),
    })
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.connected = false
    this.emit('exit', code, signal)
  }
}

function validOptions(): DshSpawnOptions {
  return {
    executable: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    cliEntry: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    runtimeRoot: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime',
    home: '/tmp/dsh-desktop-supervisor-test',
  }
}

function inertTree(): ProcessTreeLadder {
  return {
    snapshot: rootPid => ({ rootPid, rootPresent: true, owned: [] }),
    signalGroups: () => {},
    survivors: () => [],
  }
}

describe('desktop DSH supervisor', () => {
  it('rejects invalid configuration before spawning a child', async () => {
    const spawn = vi.fn()
    const supervisor = new DshSupervisor(spawn, { tree: inertTree() })

    await expect(supervisor.start({ ...validOptions(), home: '' })).rejects.toThrow(
      'desktop DSH child home must be an absolute path',
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('proves desktop Host readiness and reports an unexpected child exit', async () => {
    const child = new FakeChild(101)
    const supervisor = new DshSupervisor(() => child, {
      startupTimeoutMs: 100,
      tree: inertTree(),
    })
    const starting = supervisor.start(validOptions())

    child.ready()
    await expect(starting).resolves.toEqual({
      profile: 'desktop',
      pid: 101,
      home: '/tmp/dsh-desktop-supervisor-test',
    })
    expect(child.messages).toHaveLength(1)
    expect(child.messages[0]).toMatchObject({
      type: 'request',
      url: 'dsh://app/api/host.describe',
      method: 'POST',
    })

    const exit = supervisor.nextUnexpectedExit()
    child.exit(7)
    await expect(exit).resolves.toMatchObject({ code: 7, signal: null })
  })

  it('times out startup and joins the terminated child', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild(102)
      const supervisor = new DshSupervisor(() => child, {
        startupTimeoutMs: 10,
        shutdownTimeoutMs: 100,
        tree: inertTree(),
      })
      const starting = supervisor.start(validOptions())
      const failed = expect(starting).rejects.toThrow('did not become ready within 10ms')

      await vi.advanceTimersByTimeAsync(10)
      expect(child.signals).toEqual(['SIGTERM'])
      child.exit(null, 'SIGTERM')
      await failed
    } finally {
      vi.useRealTimers()
    }
  })

  it('performs one controlled restart and terminate-and-join stop', async () => {
    const first = new FakeChild(103)
    const second = new FakeChild(104)
    const spawn = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const supervisor = new DshSupervisor(spawn, {
      startupTimeoutMs: 100,
      tree: inertTree(),
    })

    const initial = supervisor.start(validOptions())
    first.ready()
    await initial
    const restarting = supervisor.restart()
    expect(first.signals).toEqual(['SIGTERM'])
    first.exit(null, 'SIGTERM')
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2) })
    second.ready()
    await expect(restarting).resolves.toMatchObject({ pid: 104 })

    const stopping = supervisor.stop()
    expect(second.signals).toEqual(['SIGTERM'])
    let joined = false
    void stopping.then(() => { joined = true })
    await Promise.resolve()
    expect(joined).toBe(false)
    second.exit(null, 'SIGTERM')
    await stopping
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('does not complete shutdown until every snapshotted descendant is gone', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild(105)
      const descendant: ProcessTreeEntry = {
        pid: 205,
        pgid: 205,
        started: 'Tue Aug 25 20:00:00 2026',
        command: 'node-pty spawn-helper',
      }
      const snapshot: ProcessTreeSnapshot = {
        rootPid: 105,
        rootPresent: true,
        owned: [descendant],
      }
      let alive = true
      const tree: ProcessTreeLadder = {
        snapshot: vi.fn(() => snapshot),
        signalGroups: vi.fn((_entries, signal) => {
          if (signal === 'SIGKILL') alive = false
        }),
        survivors: vi.fn(() => alive ? [descendant] : []),
      }
      const supervisor = new DshSupervisor(() => child, {
        startupTimeoutMs: 100,
        shutdownTimeoutMs: 10,
        tree,
        treeGraceMs: 10,
      })
      const starting = supervisor.start(validOptions())
      child.ready()
      await starting

      const stopping = supervisor.stop()
      child.exit(null, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(25)
      await stopping

      expect(tree.signalGroups).toHaveBeenNthCalledWith(1, [descendant], 'SIGTERM')
      expect(tree.signalGroups).toHaveBeenNthCalledWith(2, [descendant], 'SIGKILL')
      expect(tree.survivors(snapshot)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('sweeps snapshotted descendants before publishing an unexpected exit', async () => {
    const child = new FakeChild(106)
    const descendant: ProcessTreeEntry = {
      pid: 206,
      pgid: 206,
      started: 'Tue Aug 25 20:00:00 2026',
      command: 'node-pty spawn-helper',
    }
    const snapshot: ProcessTreeSnapshot = {
      rootPid: 106,
      rootPresent: true,
      owned: [descendant],
    }
    let alive = true
    const tree: ProcessTreeLadder = {
      snapshot: vi.fn(() => snapshot),
      signalGroups: vi.fn(() => { alive = false }),
      survivors: vi.fn(() => alive ? [descendant] : []),
    }
    const supervisor = new DshSupervisor(() => child, { tree })
    const starting = supervisor.start(validOptions())
    child.ready()
    await starting

    const exit = supervisor.nextUnexpectedExit()
    child.exit(9)
    await expect(exit).resolves.toEqual({ code: 9, signal: null })
    expect(tree.signalGroups).toHaveBeenCalledWith([descendant], 'SIGTERM')
    expect(tree.survivors(snapshot)).toEqual([])
  })

  it('sweeps descendants before rejecting a pre-readiness exit', async () => {
    const child = new FakeChild(107)
    const descendant: ProcessTreeEntry = {
      pid: 207,
      pgid: 207,
      started: 'Tue Aug 25 20:00:00 2026',
      command: 'node-pty spawn-helper',
    }
    const snapshot: ProcessTreeSnapshot = {
      rootPid: 107,
      rootPresent: true,
      owned: [descendant],
    }
    let alive = true
    const tree: ProcessTreeLadder = {
      snapshot: vi.fn(() => snapshot),
      signalGroups: vi.fn(() => { alive = false }),
      survivors: vi.fn(() => alive ? [descendant] : []),
    }
    const supervisor = new DshSupervisor(() => child, { tree })
    const starting = supervisor.start(validOptions())

    expect(tree.snapshot).toHaveBeenCalledWith(107)
    child.exit(1)

    await expect(starting).rejects.toThrow('exited before readiness')
    expect(tree.signalGroups).toHaveBeenCalledWith([descendant], 'SIGTERM')
    expect(tree.survivors(snapshot)).toEqual([])
  })

  it('merges a final process snapshot before unexpected-exit cleanup', async () => {
    const child = new FakeChild(108)
    const descendant: ProcessTreeEntry = {
      pid: 208,
      pgid: 208,
      started: 'Tue Aug 25 20:00:00 2026',
      command: 'late terminal child',
    }
    const first: ProcessTreeSnapshot = { rootPid: 108, rootPresent: true, owned: [] }
    const final: ProcessTreeSnapshot = { rootPid: 108, rootPresent: false, owned: [descendant] }
    let alive = true
    const tree: ProcessTreeLadder = {
      snapshot: vi.fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(first)
        .mockReturnValue(final),
      signalGroups: vi.fn(() => { alive = false }),
      survivors: vi.fn((snapshot) => alive ? snapshot.owned : []),
    }
    const supervisor = new DshSupervisor(() => child, { tree })
    const starting = supervisor.start(validOptions())
    child.ready()
    await starting

    const exit = supervisor.nextUnexpectedExit()
    child.exit(9)

    await expect(exit).resolves.toEqual({ code: 9, signal: null })
    expect(tree.snapshot).toHaveBeenCalledTimes(3)
    expect(tree.signalGroups).toHaveBeenCalledWith([descendant], 'SIGTERM')
  })

  it('contains stream listener failures while closing every subscription', async () => {
    const child = new FakeChild(109)
    const supervisor = new DshSupervisor(() => child, { tree: inertTree() })
    const starting = supervisor.start(validOptions())
    child.ready()
    await starting
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const received: string[] = []
    supervisor.onStream(() => { throw new Error('broken listener') })
    supervisor.onStream(message => { received.push(message.type) })
    supervisor.subscribe('stream-1', 'mux')

    child.emit('message', { type: 'stream-open', id: 'stream-1' })
    const exit = supervisor.nextUnexpectedExit()
    child.exit(9)
    await exit

    expect(received).toEqual(['stream-open', 'stream-error', 'stream-end'])
    expect(logged).toHaveBeenCalledWith(
      '[desktop-supervisor] stream listener threw:',
      expect.any(Error),
    )
    logged.mockRestore()
  })
})
