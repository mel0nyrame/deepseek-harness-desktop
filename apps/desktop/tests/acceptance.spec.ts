/**
 * Unit coverage for the acceptance driver's session discovery. The hero
 * picker's `connectWorkspace` mints the session the recording scenario must
 * observe, so discovery polls the durable workspace view until exactly one
 * session exists and fails loudly on zero, ambiguous, or absent workspace
 * state. A FakeChild drives the supervisor through its ordinary
 * request/response correlation — no Electron primitives participate.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopChildMessage, DesktopParentMessage } from '@deepseek-ai/dsh-desktop-app'
import { DshSupervisor, type DshChild } from '../src/supervisor.ts'
import { discoverAcceptanceSession, discoverAcceptanceWorkspaceSession } from '../src/acceptance.ts'

class FakeChild extends EventEmitter implements DshChild {
  pid = undefined
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly sent: DesktopParentMessage[] = []
  readonly killed: NodeJS.Signals[] = []

  send(message: DesktopParentMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    queueMicrotask(() => { callback?.(null) })
    return true
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal)
    return true
  }

  receive(message: DesktopChildMessage): void {
    this.emit('message', message)
  }
}

async function bootSupervisor(): Promise<{ supervisor: DshSupervisor; child: FakeChild }> {
  const child = new FakeChild()
  const supervisor = new DshSupervisor(child, { startupTimeoutMs: 100, shutdownTimeoutMs: 100 })
  const starting = supervisor.start()
  child.receive({ type: 'ready', graph: { rev: 'one', entries: [] }, bundles: [] })
  await starting
  return { supervisor, child }
}

function okWorkspaceList(sessionIds: string[]): string {
  return JSON.stringify({
    type: 'server-response',
    result: {
      ok: true,
      value: {
        items: [{
          workspaceId: 'ws-accept',
          path: '/tmp/acceptance-workspace',
          title: 'acceptance-workspace',
          sessionIds,
          createdAt: '2026-08-15T00:00:00.000Z',
          updatedAt: '2026-08-15T00:00:00.000Z',
        }],
        archivedSessionIds: [],
      },
    },
  })
}

function answer(child: FakeChild, body: string): string {
  const request = child.sent.at(-1)
  if (request === undefined || request.type !== 'request') throw new Error('no pending request to answer')
  child.receive({ type: 'response', id: request.id, status: 200, headers: [], body })
  return request.id
}

describe('discoverAcceptanceSession', () => {
  it('resolves the exactly-one session the workspace view lists', async () => {
    const { supervisor, child } = await bootSupervisor()
    const discovery = discoverAcceptanceSession(supervisor, 'ws-accept')
    expect(child.sent.at(-1)).toMatchObject({ type: 'request', id: 'accept-workspaces-0' })
    answer(child, okWorkspaceList(['session-31fd12cf']))
    await expect(discovery).resolves.toBe('session-31fd12cf')
  })

  it('polls past the zero-session window until the picker-minted session lands', async () => {
    vi.useFakeTimers()
    try {
      const { supervisor, child } = await bootSupervisor()
      const discovery = discoverAcceptanceSession(supervisor, 'ws-accept')
      expect(answer(child, okWorkspaceList([]))).toBe('accept-workspaces-0')
      await vi.advanceTimersByTimeAsync(60)
      expect(child.sent.at(-1)).toMatchObject({ type: 'request', id: 'accept-workspaces-1' })
      answer(child, okWorkspaceList(['session-74d3af54']))
      await expect(discovery).resolves.toBe('session-74d3af54')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails after the bounded poll window when the pick journey opens no session', async () => {
    vi.useFakeTimers()
    try {
      const { supervisor, child } = await bootSupervisor()
      const discovery = discoverAcceptanceSession(supervisor, 'ws-accept')
      const rejection = expect(discovery).rejects.toThrow('opened no session')
      // 10s at a 50ms poll interval is 200 answers; the deadline check trips on the next tick.
      for (let poll = 0; poll < 201; poll += 1) {
        answer(child, okWorkspaceList([]))
        await vi.advanceTimersByTimeAsync(60)
      }
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails loudly when the workspace view lists more than one session', async () => {
    const { supervisor, child } = await bootSupervisor()
    const discovery = discoverAcceptanceSession(supervisor, 'ws-accept')
    answer(child, okWorkspaceList(['session-a', 'session-b']))
    await expect(discovery).rejects.toThrow('exactly one session, found 2')
  })

  it('fails when the workspace view omits the acceptance workspace', async () => {
    const { supervisor, child } = await bootSupervisor()
    const discovery = discoverAcceptanceSession(supervisor, 'ws-missing')
    answer(child, okWorkspaceList(['session-a']))
    await expect(discovery).rejects.toThrow('omits the acceptance workspace ws-missing')
  })

  it('propagates a host-side workspace.list failure instead of polling past it', async () => {
    const { supervisor, child } = await bootSupervisor()
    const discovery = discoverAcceptanceSession(supervisor, 'ws-accept')
    answer(child, JSON.stringify({
      type: 'server-response',
      result: { ok: false, error: { code: 'unavailable', message: 'store busy' } },
    }))
    await expect(discovery).rejects.toThrow('desktop workspace.list failed')
  })
})

describe('discoverAcceptanceWorkspaceSession', () => {
  it('resolves the workspace and exactly-one session adopted through the native picker', async () => {
    const { supervisor, child } = await bootSupervisor()
    const discovery = discoverAcceptanceWorkspaceSession(supervisor, '/tmp/acceptance-workspace')
    expect(child.sent.at(-1)).toMatchObject({ type: 'request', id: 'accept-native-workspaces-0' })
    answer(child, okWorkspaceList(['session-native']))
    await expect(discovery).resolves.toEqual({
      workspaceId: 'ws-accept',
      sessionId: 'session-native',
    })
  })
})
