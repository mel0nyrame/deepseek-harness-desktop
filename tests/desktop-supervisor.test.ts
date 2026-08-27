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
  sendError: Error | undefined

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.messages.push(message as DesktopParentMessage)
    callback?.(this.sendError ?? null)
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

  it('sweeps descendants and closes streams when the root never reports exit', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild(110)
      const descendant: ProcessTreeEntry = {
        pid: 210,
        pgid: 210,
        started: 'Tue Aug 25 20:00:00 2026',
        command: 'detached terminal child',
      }
      const snapshot: ProcessTreeSnapshot = {
        rootPid: 110,
        rootPresent: true,
        owned: [descendant],
      }
      let alive = true
      const tree: ProcessTreeLadder = {
        snapshot: vi.fn(() => snapshot),
        signalGroups: vi.fn(() => { alive = false }),
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
      const streamEvents: string[] = []
      supervisor.onStream(message => { streamEvents.push(message.type) })
      supervisor.subscribe('stuck-root-stream', 'mux')

      const stopping = supervisor.stop()
      const failed = expect(stopping).rejects.toThrow('did not exit within 10ms')
      await vi.advanceTimersByTimeAsync(25)
      await failed

      expect(tree.signalGroups).toHaveBeenCalledWith([descendant], 'SIGTERM')
      expect(tree.survivors(snapshot)).toEqual([])
      expect(streamEvents).toEqual(['stream-error', 'stream-end'])
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

  it('terminates a late subscription when the child IPC channel has closed', async () => {
    const child = new FakeChild(111)
    const supervisor = new DshSupervisor(() => child, { tree: inertTree() })
    const starting = supervisor.start(validOptions())
    child.ready()
    await starting
    child.exit(9)
    const received: string[] = []
    supervisor.onStream(message => { received.push(message.type) })

    expect(() => { supervisor.subscribe('late-stream', 'mux') }).not.toThrow()

    expect(received).toEqual(['stream-error', 'stream-end'])
  })

  it('terminates a subscription when IPC reports an asynchronous send failure', async () => {
    const child = new FakeChild(112)
    const supervisor = new DshSupervisor(() => child, { tree: inertTree() })
    const starting = supervisor.start(validOptions())
    child.ready()
    await starting
    const received: string[] = []
    supervisor.onStream(message => { received.push(message.type) })
    child.sendError = new Error('broken pipe')

    expect(() => { supervisor.subscribe('failed-stream', 'mux') }).not.toThrow()

    expect(received).toEqual(['stream-error', 'stream-end'])
  })
})

function capabilityReply(child: FakeChild): Extract<DesktopParentMessage, { type: 'capability-response' | 'capability-error' }> | undefined {
  return child.messages.find(message => message.type === 'capability-response'
    || message.type === 'capability-error') as
    Extract<DesktopParentMessage, { type: 'capability-response' | 'capability-error' }> | undefined
}

describe('desktop DSH supervisor native actions', () => {
  async function started(pid = 201): Promise<{ supervisor: DshSupervisor; child: FakeChild }> {
    const child = new FakeChild(pid)
    const supervisor = new DshSupervisor(() => child, { tree: inertTree() })
    const starting = supervisor.start(validOptions())
    child.ready()
    await starting
    return { supervisor, child }
  }

  it('settles a Host-initiated pick through the installed shell adapter', async () => {
    const { supervisor, child } = await started()
    let seenRequest: unknown
    supervisor.onNativeActions(async (request) => {
      seenRequest = request
      return { kind: 'path', path: '/Users/mac/picked' }
    })

    child.emit('message', { type: 'capability-request', id: 'native-1', action: 'pick-directory' })
    await vi.waitFor(() => { expect(capabilityReply(child)).toBeDefined() })

    expect(seenRequest).toMatchObject({ type: 'capability-request', action: 'pick-directory', id: 'native-1' })
    expect(capabilityReply(child)).toEqual({ type: 'capability-response', id: 'native-1', kind: 'path', path: '/Users/mac/picked' })
  })

  it('forwards adapter rejections as capability errors with the open-path target intact', async () => {
    const { supervisor, child } = await started()
    supervisor.onNativeActions(async () => {
      throw new Error('desktop shell could not open the path: missing')
    })

    child.emit('message', { type: 'capability-request', id: 'open-1', action: 'open-path', path: '/tmp/missing.pdf' })
    await vi.waitFor(() => { expect(capabilityReply(child)).toBeDefined() })

    expect(capabilityReply(child)).toEqual({
      type: 'capability-error',
      id: 'open-1',
      message: 'desktop shell could not open the path: missing',
    })
  })

  it('answers duplicate concurrent ids without invoking the handler twice', async () => {
    const { supervisor, child } = await started()
    const handler = vi.fn((_request, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }))
    supervisor.onNativeActions(handler)

    child.emit('message', { type: 'capability-request', id: 'dup-1', action: 'pick-directory' })
    await vi.waitFor(() => { expect(handler).toHaveBeenCalledTimes(1) })
    child.emit('message', { type: 'capability-request', id: 'dup-1', action: 'pick-directory' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(capabilityReply(child)).toEqual({ type: 'capability-error', id: 'dup-1', message: 'duplicate native action id' })
    const stopping = supervisor.stop()
    child.exit(null, 'SIGTERM')
    await stopping
  })

  it('aborts in-flight native actions when the supervisor stops', async () => {
    const { supervisor, child } = await started(204)
    let handlerStarted = false
    let aborted = false
    let handlerFinished = false
    supervisor.onNativeActions(async (_request, signal) => {
      handlerStarted = true
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) { aborted = true; resolve(); return }
          signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
        })
        throw signal.reason
      } finally {
        handlerFinished = true
      }
    })

    child.emit('message', { type: 'capability-request', id: 'shutdown-1', action: 'pick-directory' })
    await vi.waitFor(() => { expect(handlerStarted).toBe(true) })
    const stopping = supervisor.stop()
    child.exit(null, 'SIGTERM')
    await stopping

    expect(aborted).toBe(true)
    expect(handlerFinished).toBe(true)
    expect(child.messages.filter(message => message.type === 'capability-response'
      || message.type === 'capability-error')).toHaveLength(0)
  })

  it('answers without a handler and after the disposer removes it', async () => {
    const { supervisor, child } = await started(202)
    const firstId = 'orphan-1'

    child.emit('message', { type: 'capability-request', id: firstId, action: 'pick-directory' })
    await vi.waitFor(() => { expect(capabilityReply(child)).toBeDefined() })
    expect(capabilityReply(child)).toEqual({
      type: 'capability-error',
      id: firstId,
      message: 'no desktop native action handler is installed',
    })

    const messagesBefore = child.messages.length
    const disposer = supervisor.onNativeActions(async () => ({ kind: 'opened' }))
    child.emit('message', { type: 'capability-request', id: 'served-2', action: 'open-path', path: '/tmp/a' })
    await vi.waitFor(() => { expect(child.messages.length).toBeGreaterThan(messagesBefore) })
    expect(child.messages.at(-1)).toEqual({ type: 'capability-response', id: 'served-2', kind: 'opened' })

    disposer()
    const totalAfterDisposal = child.messages.length
    child.emit('message', { type: 'capability-request', id: 'unserved-3', action: 'pick-directory' })
    await vi.waitFor(() => { expect(child.messages.length).toBeGreaterThan(totalAfterDisposal) })
    expect(child.messages.at(-1)).toMatchObject({ type: 'capability-error', id: 'unserved-3' })
  })

  it('aborts an in-flight action when its handler is removed', async () => {
    const { supervisor, child } = await started(212)
    let aborted = false
    const disposer = supervisor.onNativeActions(async (_request, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) { aborted = true; resolve(); return }
        signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
      })
      throw signal.reason
    })
    child.emit('message', { type: 'capability-request', id: 'removed-1', action: 'pick-directory' })
    await vi.waitFor(() => { expect(aborted).toBe(false) })
    disposer()
    await vi.waitFor(() => { expect(aborted).toBe(true) })
    await vi.waitFor(() => {
      expect(child.messages.at(-1)).toMatchObject({ type: 'capability-error', id: 'removed-1' })
    })
    const stopping = supervisor.stop()
    child.exit(null, 'SIGTERM')
    await stopping
  })

  it('drops malformed capability requests without replying', async () => {
    const { supervisor, child } = await started(203)
    const handled = vi.fn(async () => ({ kind: 'path' as const, path: '/x' }))
    supervisor.onNativeActions(handled)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const malformed of [
      { type: 'capability-request', id: 'bad-action', action: 'format-disk' },
      { type: 'capability-request', action: 'pick-directory' },
      { type: 'capability-request', id: 'relative-path', action: 'open-path', path: 'rel/path' },
      { type: 'capability-request', id: 'empty-path', action: 'open-path', path: '' },
    ]) {
      child.emit('message', malformed)
    }
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(child.messages.every(message => !String(message.type).startsWith('capability'))).toBe(true)
    expect(logged).toHaveBeenCalledWith('[desktop-supervisor] dropped malformed child IPC message')
    expect(handled).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it('keeps the adapter across generations and contains undeliverable replies', async () => {
    const first = new FakeChild(206)
    const second = new FakeChild(207)
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const supervisor = new DshSupervisor(spawn, { startupTimeoutMs: 100, tree: inertTree() })
    const initial = supervisor.start(validOptions())
    first.ready()
    await initial

    let settleAdapter!: (value: { kind: 'path'; path: null }) => void
    supervisor.onNativeActions(() => new Promise(resolve => { settleAdapter = resolve }))

    const restarting = supervisor.restart()
    first.exit(null, 'SIGTERM')
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2) })
    second.ready()
    await restarting

    second.emit('message', { type: 'capability-request', id: 'after-restart-1', action: 'pick-directory' })
    await vi.waitFor(() => { expect(settleAdapter).toBeDefined() })

    // The OS interaction outlives its generation; settling into a vanished
    // channel must be contained by the shell's own logging.
    const delivered = settleAdapter
    second.exit(null, 'SIGTERM')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      delivered({ kind: 'path', path: null })
      await vi.waitFor(() => {
        expect(logged).toHaveBeenCalledWith(
          '[desktop-supervisor] native action reply delivery failed:',
          expect.any(Error),
        )
      })
    } finally {
      logged.mockRestore()
    }
  })

  it('never delivers an old-generation native settlement to a restarted child', async () => {
    const first = new FakeChild(208)
    const second = new FakeChild(209)
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const supervisor = new DshSupervisor(spawn, { startupTimeoutMs: 100, tree: inertTree() })
    const initial = supervisor.start(validOptions())
    first.ready()
    await initial

    let settle!: (value: { kind: 'path'; path: null }) => void
    supervisor.onNativeActions((_request, signal) => new Promise((resolve, reject) => {
      settle = resolve
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }))
    first.emit('message', { type: 'capability-request', id: 'old-generation', action: 'pick-directory' })

    const restarting = supervisor.restart()
    first.exit(null, 'SIGTERM')
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2) })
    second.ready()
    await restarting

    const before = second.messages.length
    settle({ kind: 'path', path: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(second.messages.length).toBe(before)
  })

  it('does not let an old handler remove a reused id from the new generation', async () => {
    const first = new FakeChild(210)
    const second = new FakeChild(211)
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const supervisor = new DshSupervisor(spawn, { startupTimeoutMs: 100, tree: inertTree() })
    const initial = supervisor.start(validOptions())
    first.ready()
    await initial

    const releases: Array<() => void> = []
    supervisor.onNativeActions((_request, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      releases.push(() => resolve({ kind: 'path', path: null }))
    }))
    first.emit('message', { type: 'capability-request', id: 'reused-id', action: 'pick-directory' })
    const restarting = supervisor.restart()
    first.exit(null, 'SIGTERM')
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2) })
    second.ready()
    await restarting

    second.emit('message', { type: 'capability-request', id: 'reused-id', action: 'pick-directory' })
    await vi.waitFor(() => { expect(releases).toHaveLength(2) })
    releases[0]?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(second.messages.filter(message => message.type === 'capability-response')).toHaveLength(0)
    releases[1]?.()
    await vi.waitFor(() => {
      expect(second.messages.filter(message => message.type === 'capability-response')).toHaveLength(1)
    })
  })
})
