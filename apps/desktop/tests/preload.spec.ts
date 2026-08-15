import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { RendererStreamEvent } from '../src/renderer-ipc.ts'

interface ExposedDesktopBridge {
  onStream(listener: (event: RendererStreamEvent) => void): () => void
}

const electron = vi.hoisted(() => {
  const exposed: Record<string, unknown> = {}
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const sent: Array<{ channel: string; values: unknown[] }> = []
  return {
    exposed,
    sent,
    emit(channel: string, ...values: unknown[]): void {
      for (const handler of handlers.get(channel) ?? []) handler({}, ...values)
    },
    contextBridge: {
      exposeInMainWorld(name: string, value: unknown): void { exposed[name] = value },
    },
    ipcRenderer: {
      invoke: () => Promise.reject(new Error('not used')),
      on(channel: string, handler: (...args: unknown[]) => void): void {
        const listeners = handlers.get(channel) ?? new Set()
        listeners.add(handler)
        handlers.set(channel, listeners)
      },
      removeListener(channel: string, handler: (...args: unknown[]) => void): void {
        handlers.get(channel)?.delete(handler)
      },
      send(channel: string, ...values: unknown[]): void { sent.push({ channel, values }) },
      sendSync: () => ({ rev: 'test', entries: [] }),
    },
  }
})

vi.mock('electron', () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
}))

describe('desktop preload stream bridge', () => {
  let bridge: ExposedDesktopBridge

  beforeAll(async () => {
    await import('../src/preload.ts')
    bridge = electron.exposed['dshDesktop'] as ExposedDesktopBridge
  })

  it('fans out one validated notification and acknowledges it exactly once', () => {
    const received: RendererStreamEvent[] = []
    const stopThrowing = bridge.onStream(() => { throw new Error('listener failed') })
    const stopRecording = bridge.onStream((event) => { received.push(event) })

    electron.emit('dsh:stream', { type: 'open', id: 'stream-1' })

    expect(received).toEqual([{ type: 'open', id: 'stream-1' }])
    expect(electron.sent.filter(message => message.channel === 'dsh:stream-ack')).toEqual([
      { channel: 'dsh:stream-ack', values: ['stream-1'] },
    ])
    stopThrowing()
    stopRecording()
  })
})
