import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  DesktopNativeActions,
  type DesktopChildEndpoint,
  type DesktopChildMessage,
  type DesktopParentMessage,
} from '../src/index.ts'

class FakeEndpoint extends EventEmitter implements DesktopChildEndpoint {
  connected = true
  readonly sent: DesktopChildMessage[] = []
  blockCancellation = false
  private readonly cancellationCallbacks: Array<(error: Error | null) => void> = []

  send(message: DesktopChildMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    if (this.blockCancellation && message.type === 'cancel-native-request') {
      if (callback !== undefined) this.cancellationCallbacks.push(callback)
      return false
    }
    callback?.(null)
    return true
  }

  receive(message: DesktopParentMessage): void {
    this.emit('message', message)
  }

  releaseCancellation(): void {
    this.cancellationCallbacks.shift()?.(null)
  }
}

describe('desktop native actions', () => {
  it('provides the directory picker and path opener through two typed reverse requests', async () => {
    const ctx = new Context()
    const endpoint = new FakeEndpoint()
    const actions = new DesktopNativeActions(ctx, endpoint)
    const capability = actions.capability()
    if (capability.kind !== 'native') throw new Error('native capability missing')

    const picked = capability.pick(new AbortController().signal)
    const pickRequest = endpoint.sent.at(-1)
    expect(pickRequest).toMatchObject({ type: 'native-request', request: { type: 'pick-directory' } })
    if (pickRequest?.type !== 'native-request') throw new Error('pick request missing')
    endpoint.receive({
      type: 'native-response', id: pickRequest.id,
      result: { ok: true, value: { type: 'pick-directory', path: '/workspace/alpha' } },
    })
    await expect(picked).resolves.toBe('/workspace/alpha')

    const opened = actions.open('/workspace/alpha/readme.md', new AbortController().signal)
    const openRequest = endpoint.sent.at(-1)
    expect(openRequest).toMatchObject({
      type: 'native-request', request: { type: 'open-path', path: '/workspace/alpha/readme.md' },
    })
    if (openRequest?.type !== 'native-request') throw new Error('open request missing')
    endpoint.receive({
      type: 'native-response', id: openRequest.id,
      result: { ok: true, value: { type: 'open-path', opened: true } },
    })
    await expect(opened).resolves.toBeUndefined()

    expect(ctx.get('directoryPicker')?.capability().kind).toBe('native')
    expect(ctx.get('nativePathOpener')?.available()).toBe(true)
    await actions.dispose()
  })

  it('cancels a pending reverse request and ignores its late settlement', async () => {
    const endpoint = new FakeEndpoint()
    const actions = new DesktopNativeActions(new Context(), endpoint)
    const abort = new AbortController()
    const pending = actions.open('/workspace/a.txt', abort.signal)
    const request = endpoint.sent.at(-1)
    if (request?.type !== 'native-request') throw new Error('native request missing')

    abort.abort(new Error('renderer disconnected'))

    await expect(pending).rejects.toThrow(/renderer disconnected/)
    expect(endpoint.sent.at(-1)).toEqual({ type: 'cancel-native-request', id: request.id })
    endpoint.receive({
      type: 'native-response', id: request.id,
      result: { ok: true, value: { type: 'open-path', opened: true } },
    })
    await actions.dispose()
  })

  it('rejects failed and malformed responses without retaining the operation', async () => {
    const endpoint = new FakeEndpoint()
    const actions = new DesktopNativeActions(new Context(), endpoint)
    const failed = actions.open('/missing', new AbortController().signal)
    const failureRequest = endpoint.sent.at(-1)
    if (failureRequest?.type !== 'native-request') throw new Error('native request missing')
    endpoint.receive({
      type: 'native-response', id: failureRequest.id,
      result: { ok: false, error: { code: 'unavailable', message: 'path does not exist' } },
    })
    await expect(failed).rejects.toThrow(/path does not exist/)

    const malformed = actions.open('/workspace/a.txt', new AbortController().signal)
    const malformedRequest = endpoint.sent.at(-1)
    if (malformedRequest?.type !== 'native-request') throw new Error('native request missing')
    endpoint.emit('message', {
      type: 'native-response', id: malformedRequest.id,
      result: { ok: true, value: { type: 'pick-directory', path: null } },
    })
    await expect(malformed).rejects.toThrow(/malformed native response/)
    await actions.dispose()
  })

  it('rejects a selected path that is not absolute at the reverse-response boundary', async () => {
    const endpoint = new FakeEndpoint()
    const actions = new DesktopNativeActions(new Context(), endpoint)
    const capability = actions.capability()
    if (capability.kind !== 'native') throw new Error('native capability missing')
    const pending = capability.pick(new AbortController().signal)
    const request = endpoint.sent.at(-1)
    if (request?.type !== 'native-request') throw new Error('native request missing')

    endpoint.receive({
      type: 'native-response', id: request.id,
      result: { ok: true, value: { type: 'pick-directory', path: 'relative/workspace' } },
    })

    await expect(pending).rejects.toThrow(/malformed native response/)
    await actions.dispose()
  })

  it('settles every pending action when the product assembly is disposed', async () => {
    const endpoint = new FakeEndpoint()
    endpoint.blockCancellation = true
    const actions = new DesktopNativeActions(new Context(), endpoint)
    const pending = actions.open('/workspace/a.txt', new AbortController().signal)
    const request = endpoint.sent.at(-1)
    if (request?.type !== 'native-request') throw new Error('native request missing')

    const disposing = actions.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    await Promise.resolve()

    await expect(pending).rejects.toThrow(/desktop native actions disposed/)
    expect(endpoint.sent.at(-1)).toEqual({ type: 'cancel-native-request', id: request.id })
    expect(disposed).toBe(false)
    endpoint.releaseCancellation()
    await disposing
    expect(endpoint.listenerCount('message')).toBe(0)
  })
})
