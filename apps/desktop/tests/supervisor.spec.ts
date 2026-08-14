import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopChildMessage, DesktopParentMessage } from '@deepseek-ai/dsh-desktop-app'
import { DshSupervisor, type DshChild } from '../src/supervisor.ts'

class FakeChild extends EventEmitter implements DshChild {
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly sent: DesktopParentMessage[] = []
  readonly killed: NodeJS.Signals[] = []

  send(message: DesktopParentMessage): boolean {
    this.sent.push(message)
    return true
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
})
