import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseDesktopCapabilityRequest,
  parseDesktopParentMessage,
} from '../packages/connection/src/protocol.js'
import type {
  DesktopCapabilityValue,
  DesktopChildEndpoint,
} from '../packages/connection/src/index.js'
import { createNativeActionChannel, internals as nativeInternals } from '../packages/native/src/channel.js'
import DesktopDirectoryPicker from '../packages/native/src/index.js'

const nativeRequire = createRequire(new URL('../packages/native/package.json', import.meta.url))
const { Context } = nativeRequire('@deepseek-ai/cordis') as {
  Context: new () => ConstructorParameters<typeof DesktopDirectoryPicker>[0]
}

const mountedContexts = new Set<InstanceType<typeof Context>>()
const ownedReleases = new Set<() => void>()

afterEach(async () => {
  for (const release of ownedReleases) release()
  ownedReleases.clear()
  for (const context of mountedContexts) await context.fiber.dispose()
  mountedContexts.clear()
})

/** Stand-in for the forked child's IPC endpoint, driven from the shell side. */
class ShellEndpoint extends EventEmitter implements DesktopChildEndpoint {
  connected = true
  readonly sent: Array<Record<string, unknown>> = []
  sendError: Error | undefined

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message as Record<string, unknown>)
    callback?.(this.sendError ?? null)
    return this.connected
  }

  /** Emulate Electron main settling one outstanding request. */
  settle(id: string, value: DesktopCapabilityValue): void {
    this.emit('message', { type: 'capability-response', id, ...value })
  }

  fail(id: string, message: string): void {
    this.emit('message', { type: 'capability-error', id, message })
  }

  disconnect(): void {
    this.connected = false
    this.emit('disconnect')
  }
}

function owned(endpoint: ShellEndpoint): ReturnType<typeof createNativeActionChannel> {
  const channel = createNativeActionChannel(endpoint)
  const release = channel.acquire()
  ownedReleases.add(release)
  return Object.assign(channel, { release })
}

describe('desktop native action channel', () => {
  it('correlates one pick-directory request with its path settlement', async () => {
    const endpoint = new ShellEndpoint()
    const channel = owned(endpoint)
    const abort = new AbortController()
    const pending = channel.request({ action: 'pick-directory' }, abort.signal)

    expect(endpoint.sent).toHaveLength(1)
    const request = parseDesktopCapabilityRequest(endpoint.sent[0])
    expect(request?.action).toBe('pick-directory')
    expect(request?.type).toBe('capability-request')
    endpoint.settle(request?.id as string, { kind: 'path', path: '/Users/mac/workspaces/demo' })

    await expect(pending).resolves.toEqual({ kind: 'path', path: '/Users/mac/workspaces/demo' })
  })

  it('sends absolute paths for open-path and settles opened', async () => {
    const endpoint = new ShellEndpoint()
    const channel = owned(endpoint)
    const pending = channel.request({ action: 'open-path', path: '/tmp/report.pdf' }, new AbortController().signal)

    const request = parseDesktopCapabilityRequest(endpoint.sent[0])
    expect(request)
      .toEqual({ type: 'capability-request', action: 'open-path', id: request?.id, path: '/tmp/report.pdf' })
    endpoint.settle(request?.id as string, { kind: 'opened' })

    await expect(pending).resolves.toEqual({ kind: 'opened' })
  })

  it('rejects non-absolute open-path arguments before touching the wire', async () => {
    const endpoint = new ShellEndpoint()
    const channel = owned(endpoint)

    await expect(channel.request(
      { action: 'open-path', path: 'relative/path' },
      new AbortController().signal,
    )).rejects.toThrow('needs an absolute filesystem path')
    expect(endpoint.sent).toHaveLength(0)
  })

  it('surfaces shell errors and ignores late settlements after completion', async () => {
    const endpoint = new ShellEndpoint()
    const channel = owned(endpoint)
    const pending = channel.request({ action: 'pick-directory' }, new AbortController().signal)
    const id = parseDesktopCapabilityRequest(endpoint.sent[0])?.id as string

    endpoint.fail(id, 'no desktop native action handler is installed')
    await expect(pending).rejects.toThrow('no desktop native action handler is installed')

    expect(() => endpoint.settle(id, { kind: 'path', path: '/late' })).not.toThrow()
  })

  it('drops malformed settlements without disturbing live requests', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const endpoint = new ShellEndpoint()
      const channel = owned(endpoint)
      const pending = channel.request({ action: 'open-path', path: '/tmp/x' }, new AbortController().signal)

      endpoint.emit('message', { type: 'capability-response', id: 'unknown-id', kind: 'opened' })
      endpoint.emit('message', { type: 'capability-response', kind: 'opened' })
      endpoint.emit('message', { type: 'capability-error', id: 'x' })
      expect(parseDesktopParentMessage({ type: 'capability-response', id: 'n', kind: 'bogus' })).toBeUndefined()

      const id = parseDesktopCapabilityRequest(endpoint.sent[0])?.id as string
      endpoint.settle(id, { kind: 'opened' })
      await expect(pending).resolves.toEqual({ kind: 'opened' })
      expect(logged).toHaveBeenCalledWith('[desktop-native] dropped malformed capability response')
    } finally {
      logged.mockRestore()
    }
  })

  it('fails a live request when its matching settlement is malformed', async () => {
    const endpoint = new ShellEndpoint()
    const channel = owned(endpoint)
    const pending = channel.request({ action: 'pick-directory' }, new AbortController().signal)
    const id = parseDesktopCapabilityRequest(endpoint.sent[0])?.id as string

    endpoint.emit('message', { type: 'capability-response', id, kind: 'bogus' })

    await expect(pending).rejects.toThrow('malformed capability response')
  })

  it('rejects a cancelled request and never revives it from a late settlement', async () => {
    const endpoint = new ShellEndpoint()
    const channel = owned(endpoint)
    const abort = new AbortController()
    const pending = channel.request({ action: 'pick-directory' }, abort.signal)
    const id = parseDesktopCapabilityRequest(endpoint.sent[0])?.id as string

    abort.abort(new Error('caller abandoned the chooser'))
    await expect(pending).rejects.toThrow('caller abandoned the chooser')

    endpoint.settle(id, { kind: 'path', path: '/too-late' })
    const next = channel.request({ action: 'pick-directory' }, new AbortController().signal)
    const nextId = parseDesktopCapabilityRequest(endpoint.sent[1])?.id as string
    expect(nextId).not.toBe(id)
    endpoint.settle(nextId, { kind: 'path', path: null })
    await expect(next).resolves.toEqual({ kind: 'path', path: null })
  })

  it('settles every live caller when the shell side disconnects', async () => {
    const endpoint = new ShellEndpoint()
    const channel = owned(endpoint)
    const cancelled = channel.request({ action: 'pick-directory' }, new AbortController().signal)

    endpoint.disconnect()
    await expect(cancelled).rejects.toThrow('Electron IPC channel closed')
  })

  it('reports asynchronous send failures as request failures', async () => {
    const endpoint = new ShellEndpoint()
    endpoint.sendError = new Error('broken pipe')
    const channel = owned(endpoint)
    await expect(channel.request(
      { action: 'pick-directory' },
      new AbortController().signal,
    )).rejects.toThrow('desktop native actions send failed: broken pipe')
  })

  it('shares one channel per endpoint and detaches its listener at the last release', async () => {
    const endpoint = new ShellEndpoint()
    const first = createNativeActionChannel(endpoint)
    const second = createNativeActionChannel(endpoint)
    expect(first).toBe(second)
    const releaseFirst = first.acquire()
    const releaseSecond = second.acquire()

    releaseSecond()
    expect(endpoint.listenerCount('message')).toBeGreaterThan(0)
    releaseFirst()
    expect(endpoint.listenerCount('message')).toBe(0)
  })
})

describe('desktop directory-picker provider', () => {
  function mount(): { picker: InstanceType<typeof DesktopDirectoryPicker>; endpoint: ShellEndpoint; context: InstanceType<typeof Context> } {
    const endpoint = new ShellEndpoint()
    const previous = nativeInternals.endpoint
    nativeInternals.endpoint = endpoint
    const context = new Context()
    mountedContexts.add(context)
    try {
      return { picker: new DesktopDirectoryPicker(context), endpoint, context }
    } finally {
      nativeInternals.endpoint = previous
    }
  }

  it('registers under the ctx.directoryPicker seam with one stable native capability', () => {
    const context = new Context()
    mountedContexts.add(context)
    const picker = new DesktopDirectoryPicker(context)
    const capability = picker.capability()
    expect(capability.kind).toBe('native')
    expect(picker.capability()).toBe(capability)
  })

  it('drives host.pickDirectory through the reverse-request leg', async () => {
    const { picker, endpoint } = mount()
    const pending = picker.capability().pick(new AbortController().signal)

    expect(endpoint.sent).toHaveLength(1)
    const id = parseDesktopCapabilityRequest(endpoint.sent[0])?.id as string
    endpoint.settle(id, { kind: 'path', path: '/Users/mac/workspaces/picked' })
    await expect(pending).resolves.toBe('/Users/mac/workspaces/picked')
  })

  it('maps operator cancellation onto the null pick result', async () => {
    const { picker, endpoint } = mount()
    const pending = picker.capability().pick(new AbortController().signal)
    const id = parseDesktopCapabilityRequest(endpoint.sent[0])?.id as string

    endpoint.settle(id, { kind: 'path', path: null })

    await expect(pending).resolves.toBeNull()
  })

  it('rejects mismatched or failed settlements so consumers see the real failure', async () => {
    const { picker, endpoint, context } = mount()
    const cancelledByCaller = new AbortController()
    const pending = picker.capability().pick(cancelledByCaller.signal)
    const id = parseDesktopCapabilityRequest(endpoint.sent[0])?.id as string
    endpoint.fail(id, 'desktop directory chooser crashed')
    await expect(pending).rejects.toThrow('desktop directory chooser crashed')

    cancelledByCaller.abort(new Error('gone'))
    await expect(picker.capability().pick(cancelledByCaller.signal)).rejects.toThrow('gone')
    await context.fiber.dispose()
  })

  it('rejects a live pick and detaches the endpoint when its provider is disposed', async () => {
    const { picker, endpoint, context } = mount()
    const pending = picker.capability().pick(new AbortController().signal)

    expect(endpoint.listenerCount('message')).toBeGreaterThan(0)
    await context.fiber.dispose()

    await expect(pending).rejects.toThrow('desktop directory picker is disposed')
    expect(endpoint.listenerCount('message')).toBe(0)
    expect(endpoint.listenerCount('disconnect')).toBe(0)
    await expect(picker.capability().pick(new AbortController().signal)).rejects.toThrow('desktop directory picker is disposed')
  })
})
