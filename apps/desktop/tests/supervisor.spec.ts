import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopChildMessage, DesktopParentMessage } from '@deepseek-ai/dsh-desktop-app'
import { DshSupervisor, parseDesktopChildMessage, type DshChild } from '../src/supervisor.ts'

class FakeChild extends EventEmitter implements DshChild {
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly sent: DesktopParentMessage[] = []
  readonly killed: NodeJS.Signals[] = []
  sendResult = true
  nextSendError: Error | undefined

  send(message: DesktopParentMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    const error = this.nextSendError
    this.nextSendError = undefined
    queueMicrotask(() => { callback?.(error ?? null) })
    return this.sendResult
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal)
    return true
  }

  receive(message: DesktopChildMessage): void {
    this.emit('message', message)
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.connected = false
    this.emit('exit', code, signal)
  }

  disconnect(): void {
    this.connected = false
    this.emit('disconnect')
  }
}

describe('desktop DSH supervisor', () => {
  it('correlates readiness, requests, streams, and terminate-and-join shutdown', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child, { startupTimeoutMs: 100, shutdownTimeoutMs: 100 })
    const starting = supervisor.start()
    child.receive({ type: 'ready', graph: { rev: 'one', entries: [] }, bundles: [] })
    await expect(starting).resolves.toMatchObject({ type: 'ready' })

    const response = supervisor.request({
      type: 'request', id: 'request-1', url: 'dsh://app/api/session.list', method: 'POST', headers: [], body: '{}',
    })
    expect(child.sent.at(-1)).toMatchObject({ type: 'request', id: 'request-1' })
    child.receive({ type: 'response', id: 'request-1', status: 200, headers: [], body: '{}' })
    await expect(response).resolves.toMatchObject({ status: 200 })

    const streams: DesktopChildMessage[] = []
    supervisor.onStream((message) => { streams.push(message) })
    supervisor.subscribe('stream-1', 'mux')
    child.receive({ type: 'stream-open', id: 'stream-1' })
    child.receive({ type: 'stream-end', id: 'stream-1' })
    expect(streams).toEqual([
      { type: 'stream-open', id: 'stream-1' },
      { type: 'stream-end', id: 'stream-1' },
    ])

    const stopping = supervisor.stop()
    expect(child.killed).toEqual(['SIGTERM'])
    child.exit()
    await expect(stopping).resolves.toBeUndefined()
  })

  it('kills a child that misses the bounded graceful shutdown deadline', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const supervisor = new DshSupervisor(child, { shutdownTimeoutMs: 10 })
      const stopping = supervisor.stop()
      await vi.advanceTimersByTimeAsync(10)
      expect(child.killed).toEqual(['SIGTERM', 'SIGKILL'])
      child.exit(null, 'SIGKILL')
      await expect(stopping).rejects.toThrow(/did not exit within 10ms/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops malformed child messages before stream dispatch', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child)
    const streams: DesktopChildMessage[] = []
    supervisor.onStream((message) => { streams.push(message) })
    supervisor.subscribe('stream-1', 'mux')

    child.receive({ type: 'stream-message', id: 'stream-1' } as unknown as DesktopChildMessage)

    expect(streams).toEqual([])
    child.exit()
    await supervisor.stop()
  })

  it('settles a cancelled request and releases its correlation immediately', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child)
    const pending = supervisor.request({
      type: 'request', id: 'request-1', url: 'dsh://app/api/session.list', method: 'POST', headers: [], body: '{}',
    })

    supervisor.cancelRequest('request-1')

    await expect(pending).rejects.toThrow(/cancelled/)
    expect(child.sent.at(-1)).toEqual({ type: 'cancel-request', id: 'request-1' })
    child.exit()
    await supervisor.stop()
  })

  it('closes every active stream when the child exits unexpectedly', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child)
    const streams: DesktopChildMessage[] = []
    supervisor.onStream((message) => { streams.push(message) })
    supervisor.subscribe('stream-1', 'mux')

    child.exit(1)

    expect(streams).toEqual([
      {
        type: 'stream-error',
        id: 'stream-1',
        message: 'desktop DSH child exited before shutdown completed (code 1, signal null)',
      },
      { type: 'stream-end', id: 'stream-1' },
    ])
    await supervisor.stop()
  })

  it('cancels every renderer-owned resource when its lifecycle ends', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child)
    const pending = supervisor.request({
      type: 'request', id: 'request-1', url: 'dsh://app/api/session.list', method: 'POST', headers: [], body: '{}',
    })
    supervisor.subscribe('stream-1', 'mux')

    supervisor.disconnectRenderer()

    await expect(pending).rejects.toThrow(/renderer disconnected/)
    expect(child.sent.slice(-2)).toEqual([
      { type: 'cancel-request', id: 'request-1' },
      { type: 'cancel-subscription', id: 'stream-1' },
    ])
    child.receive({ type: 'stream-message', id: 'stream-1', message: { ignored: true } })
    child.exit()
    await supervisor.stop()
  })

  it('keeps queued requests and subscriptions alive when child IPC applies backpressure', async () => {
    const child = new FakeChild()
    child.sendResult = false
    const supervisor = new DshSupervisor(child)
    const pending = supervisor.request({
      type: 'request', id: 'request-1', url: 'dsh://app/api/session.list', method: 'POST', headers: [], body: '{}',
    })
    const streams: DesktopChildMessage[] = []
    supervisor.onStream((message) => { streams.push(message) })
    supervisor.subscribe('stream-1', 'mux')
    child.receive({ type: 'response', id: 'request-1', status: 200, headers: [], body: '{}' })
    child.receive({ type: 'stream-open', id: 'stream-1' })
    child.receive({ type: 'stream-end', id: 'stream-1' })

    await expect(pending).resolves.toMatchObject({ status: 200 })
    expect(streams).toEqual([
      { type: 'stream-open', id: 'stream-1' },
      { type: 'stream-end', id: 'stream-1' },
    ])
    child.exit()
    await supervisor.stop()
  })

  it('terminates a subscription when its child IPC send callback fails', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child)
    const streams: DesktopChildMessage[] = []
    supervisor.onStream((message) => { streams.push(message) })
    child.nextSendError = new Error('pipe closed')

    supervisor.subscribe('stream-1', 'mux')
    await Promise.resolve()

    expect(streams).toEqual([
      { type: 'stream-error', id: 'stream-1', message: 'desktop DSH child IPC send failed: pipe closed' },
      { type: 'stream-end', id: 'stream-1' },
    ])
    child.exit()
    await supervisor.stop()
  })

  it('settles every active resource when the child IPC channel disconnects', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child)
    const streams: DesktopChildMessage[] = []
    let requestFailure: string | undefined
    supervisor.onStream((message) => { streams.push(message) })
    void supervisor.request({
      type: 'request', id: 'request-1', url: 'dsh://app/api/session.list', method: 'POST', headers: [], body: '{}',
    }).catch((error: unknown) => { requestFailure = String(error) })
    supervisor.subscribe('stream-1', 'mux')

    child.disconnect()
    await Promise.resolve()

    expect(requestFailure).toContain('IPC channel disconnected')
    expect(streams).toEqual([
      { type: 'stream-error', id: 'stream-1', message: 'desktop DSH child IPC channel disconnected' },
      { type: 'stream-end', id: 'stream-1' },
    ])
    child.exit()
    await supervisor.stop()
  })

  it('admits ready bundle files only from the configured runtime root', async () => {
    const root = await mkdtemp(join(process.cwd(), '.desktop-bundles-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-outside-'))
    try {
      const inside = join(root, 'client.js')
      const outside = join(outsideRoot, 'client.js')
      await writeFile(inside, 'export {}\n')
      await writeFile(outside, 'export {}\n')
      const ready = (path: string): DesktopChildMessage => ({
        type: 'ready',
        graph: { rev: 'one', entries: [{ id: 'client', url: '/client.js', rev: 'one' }] },
        bundles: [{ id: 'client', path }],
      })

      expect(parseDesktopChildMessage(ready(inside))).toEqual(ready(inside))
      expect(parseDesktopChildMessage(ready(outside))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('terminates a rejected duplicate logical subscription', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child)
    const streams: DesktopChildMessage[] = []
    supervisor.onStream((message) => { streams.push(message) })

    supervisor.subscribe('mux-1', 'mux')
    supervisor.subscribe('mux-2', 'mux')

    expect(streams).toEqual([
      { type: 'stream-error', id: 'mux-2', message: 'duplicate mux subscription' },
      { type: 'stream-end', id: 'mux-2' },
    ])
    child.exit()
    await supervisor.stop()
  })

  it('waits for stream-end before starting a replacement logical subscription', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child)

    supervisor.subscribe('mux-1', 'mux')
    supervisor.cancelSubscription('mux-1')
    supervisor.subscribe('mux-2', 'mux')

    expect(child.sent).toEqual([
      { type: 'subscribe', id: 'mux-1', stream: 'mux' },
      { type: 'cancel-subscription', id: 'mux-1' },
    ])
    child.receive({ type: 'stream-error', id: 'mux-1', message: 'closing' })
    expect(child.sent).toHaveLength(2)
    child.receive({ type: 'stream-end', id: 'mux-1' })
    expect(child.sent.at(-1)).toEqual({ type: 'subscribe', id: 'mux-2', stream: 'mux' })
    child.exit()
    await supervisor.stop()
  })

  it('suppresses messages from a cancelling renderer generation', async () => {
    const child = new FakeChild()
    const supervisor = new DshSupervisor(child)
    const streams: DesktopChildMessage[] = []
    supervisor.onStream((message) => { streams.push(message) })

    supervisor.subscribe('mux-1', 'mux')
    supervisor.disconnectRenderer()
    supervisor.subscribe('mux-2', 'mux')
    child.receive({ type: 'stream-message', id: 'mux-1', message: { stale: true } })
    child.receive({ type: 'stream-end', id: 'mux-1' })
    child.receive({ type: 'stream-open', id: 'mux-2' })

    expect(streams).toEqual([{ type: 'stream-open', id: 'mux-2' }])
    child.exit()
    await supervisor.stop()
  })

  it.each(['request', 'subscription'] as const)(
    'fails closed when %s cancellation cannot be delivered to the child',
    async (resource) => {
      const child = new FakeChild()
      const supervisor = new DshSupervisor(child)
      const streams: DesktopChildMessage[] = []
      supervisor.onStream((message) => { streams.push(message) })
      let pending: Promise<unknown> | undefined
      if (resource === 'request') {
        pending = supervisor.request({
          type: 'request', id: 'request-1', url: 'dsh://app/api/session.list', method: 'POST', headers: [], body: '{}',
        })
      } else {
        supervisor.subscribe('stream-1', 'mux')
      }
      child.nextSendError = new Error('pipe closed')

      if (resource === 'request') supervisor.cancelRequest('request-1')
      else supervisor.cancelSubscription('stream-1')
      await Promise.resolve()

      if (pending !== undefined) await expect(pending).rejects.toThrow(/cancelled/)
      else {
        expect(streams).toEqual([
          { type: 'stream-error', id: 'stream-1', message: 'desktop DSH child IPC send failed: pipe closed' },
          { type: 'stream-end', id: 'stream-1' },
        ])
      }
      expect(child.killed).toEqual(['SIGTERM'])
      child.exit()
      await supervisor.stop()
    },
  )
})
