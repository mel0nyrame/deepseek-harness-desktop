import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_STREAM_QUEUE_LIMIT,
  DesktopApiClient,
  type DesktopBridge,
  type DesktopStreamEvent,
} from '../src/client/desktop-api-client.ts'

describe('desktop api client', () => {
  it('bounds a suspended renderer stream and cancels the physical subscription', async () => {
    const listeners = new Set<(event: DesktopStreamEvent) => void>()
    let subscriptionId: string | undefined
    let cancellations = 0
    const publish = (event: DesktopStreamEvent): void => {
      for (const listener of listeners) listener(event)
    }
    const bridge: DesktopBridge = {
      request: () => Promise.reject(new Error('not used')),
      cancelRequest: () => {},
      subscribe(id) { subscriptionId = id },
      cancelSubscription(id) {
        if (id === subscriptionId) cancellations += 1
      },
      onStream(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const client = new DesktopApiClient(bridge)
    const observed: unknown[] = []
    client.subscribeEnvelopes((batch) => { observed.push(...batch) })
    const iterator = client.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(() => { expect(subscriptionId).toEqual(expect.any(String)) })
    const id = subscriptionId as string
    publish({ type: 'open', id })
    publish({
      type: 'message',
      id,
      message: {
        type: 'server-request', rpcId: 'first', method: 'session/subscribed',
        payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 1 },
      },
    })
    await expect(first).resolves.toMatchObject({ value: { rpcId: 'first' } })

    for (let index = 0; index < 2_048; index += 1) {
      publish({
        type: 'message',
        id,
        message: {
          type: 'server-request', rpcId: `queued-${String(index)}`, method: 'session/subscribed',
          payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: index + 2 },
        },
      })
    }

    await vi.waitFor(() => { expect(cancellations).toBeGreaterThan(0) })
    await Promise.resolve()
    expect(observed).toHaveLength(DESKTOP_STREAM_QUEUE_LIMIT + 1)
    await expect(iterator.next()).rejects.toThrow(/queue limit/)
  })

  it('drops queued frames when the renderer cancels a suspended stream', async () => {
    const listeners = new Set<(event: DesktopStreamEvent) => void>()
    let subscriptionId: string | undefined
    const controller = new AbortController()
    const publish = (event: DesktopStreamEvent): void => {
      for (const listener of listeners) listener(event)
    }
    const bridge: DesktopBridge = {
      request: () => Promise.reject(new Error('not used')),
      cancelRequest: () => {},
      subscribe(id) { subscriptionId = id },
      cancelSubscription: () => {},
      onStream(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const iterator = new DesktopApiClient(bridge).events.mux({}, controller.signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(() => { expect(subscriptionId).toEqual(expect.any(String)) })
    const id = subscriptionId as string
    publish({ type: 'open', id })
    for (const rpcId of ['first', 'queued']) {
      publish({
        type: 'message',
        id,
        message: {
          type: 'server-request', rpcId, method: 'session/subscribed',
          payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 1 },
        },
      })
    }
    await expect(first).resolves.toMatchObject({ value: { rpcId: 'first' } })

    controller.abort()

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })
})
