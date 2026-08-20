import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopFetch,
  DESKTOP_STREAM_QUEUE_LIMIT,
  DesktopApiClient,
  type DesktopBridge,
  type DesktopBridgeRequest,
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
      ackStream: () => {},
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
      ackStream: () => {},
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

  it('acknowledges each event only after the consumer has taken it', async () => {
    const listeners = new Set<(event: DesktopStreamEvent) => void>()
    let subscriptionId: string | undefined
    const acks: string[] = []
    const publish = (event: DesktopStreamEvent): void => {
      for (const listener of listeners) listener(event)
    }
    const bridge: DesktopBridge = {
      request: () => Promise.reject(new Error('not used')),
      cancelRequest: () => {},
      subscribe(id) { subscriptionId = id },
      cancelSubscription: () => {},
      ackStream(id) { if (id === subscriptionId) acks.push(id) },
      onStream(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const iterator = new DesktopApiClient(bridge).events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(() => { expect(subscriptionId).toEqual(expect.any(String)) })
    const id = subscriptionId as string
    const frame = (rpcId: string): DesktopStreamEvent => ({
      type: 'message',
      id,
      message: {
        type: 'server-request', rpcId, method: 'session/subscribed',
        payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 1 },
      },
    })

    publish({ type: 'open', id })
    publish(frame('first'))
    publish(frame('second'))

    // Open is consumed as soon as it is dispatched; frames wait for the reader.
    await expect(first).resolves.toMatchObject({ value: { rpcId: 'first' } })
    expect(acks).toEqual([id])

    const second = iterator.next()
    await expect(second).resolves.toMatchObject({ value: { rpcId: 'second' } })
    expect(acks).toEqual([id, id])

    publish({ type: 'end', id })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(acks).toEqual([id, id, id, id])
  })

  it('passes only string unary bodies across the bridge', async () => {
    const requests: DesktopBridgeRequest[] = []
    const bridge: DesktopBridge = {
      request: async (request) => {
        requests.push(request)
        return { status: 200, headers: [], body: '' }
      },
      cancelRequest: () => {},
      subscribe: () => {},
      cancelSubscription: () => {},
      ackStream: () => {},
      onStream: () => () => {},
    }
    const fetch = createDesktopFetch(bridge)

    await fetch('http://example.test/omitted')
    expect(requests[0]).toMatchObject({
      url: 'http://example.test/omitted', method: 'GET', headers: [],
    })
    expect(requests[0]?.body).toBeUndefined()

    await fetch('http://example.test/null', { body: null })
    expect(requests[1]?.body).toBeUndefined()

    await expect(fetch('http://example.test/non-string', {
      method: 'POST',
      body: new Blob(['payload']),
    })).rejects.toThrow(/desktop carrier only accepts string request bodies/)
  })

  it('forwards string, URL, and Request inputs with their respective method and headers', async () => {
    const requests: DesktopBridgeRequest[] = []
    const bridge: DesktopBridge = {
      request: async (request) => {
        requests.push(request)
        return { status: 200, headers: [['content-type', 'text/plain']], body: 'ok' }
      },
      cancelRequest: () => {},
      subscribe: () => {},
      cancelSubscription: () => {},
      ackStream: () => {},
      onStream: () => () => {},
    }
    const fetch = createDesktopFetch(bridge)

    await fetch('http://example.test/string')
    await fetch(new URL('http://example.test/url'), {
      method: 'PUT',
      headers: { 'x-init': 'present' },
      body: 'payload',
      signal: new AbortController().signal,
    })
    await fetch(new Request('http://example.test/request', {
      method: 'POST',
      headers: { 'x-request': 'present' },
    }))

    expect(requests[0]).toMatchObject({ url: 'http://example.test/string', method: 'GET', headers: [] })
    expect(requests[0]?.body).toBeUndefined()
    expect(requests[1]).toMatchObject({
      url: 'http://example.test/url', method: 'PUT', headers: [['x-init', 'present']], body: 'payload',
    })
    expect(requests[2]).toMatchObject({
      url: 'http://example.test/request', method: 'POST', headers: [['x-request', 'present']],
    })
  })

  it('rejects an already-aborted unary request and cancels a pending request on abort', async () => {
    let resolvePending: ((response: Awaited<ReturnType<DesktopBridge['request']>>) => void) | undefined
    const cancelled: string[] = []
    const bridge: DesktopBridge = {
      request: request => new Promise((resolve) => {
        if (request.url === 'http://example.test/pending') resolvePending = resolve
        else resolve({ status: 200, headers: [], body: 'done' })
      }),
      cancelRequest(id) { cancelled.push(id) },
      subscribe: () => {},
      cancelSubscription: () => {},
      ackStream: () => {},
      onStream: () => () => {},
    }
    const fetch = createDesktopFetch(bridge)
    const aborted = new AbortController()
    aborted.abort(new Error('already aborted'))
    await expect(fetch('http://example.test/aborted', { signal: aborted.signal }))
      .rejects.toThrow('already aborted')

    const controller = new AbortController()
    const pending = fetch('http://example.test/pending', { signal: controller.signal })
    controller.abort(new Error('renderer left'))
    await expect(pending).rejects.toThrow('renderer left')
    await vi.waitFor(() => { expect(cancelled).toHaveLength(1) })
    resolvePending?.({ status: 200, headers: [], body: 'late' })
  })

  it('surfaces a physical stream error through the suspended iterator', async () => {
    const listeners = new Set<(event: DesktopStreamEvent) => void>()
    let subscriptionId: string | undefined
    const publish = (event: DesktopStreamEvent): void => {
      for (const listener of listeners) listener(event)
    }
    const bridge: DesktopBridge = {
      request: () => Promise.reject(new Error('not used')),
      cancelRequest: () => {},
      subscribe(id) { subscriptionId = id },
      cancelSubscription: () => {},
      ackStream: () => {},
      onStream(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const iterator = new DesktopApiClient(bridge).events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    await vi.waitFor(() => { expect(subscriptionId).toEqual(expect.any(String)) })
    const id = subscriptionId as string
    publish({ type: 'open', id })
    publish({ type: 'error', id, message: 'renderer relay closed' })
    await expect(next).rejects.toThrow('renderer relay closed')
  })

  it('cancels the physical subscription when the stream starts already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let cancellations = 0
    const bridge: DesktopBridge = {
      request: () => Promise.reject(new Error('not used')),
      cancelRequest: () => {},
      subscribe: () => {},
      cancelSubscription() { cancellations += 1 },
      ackStream: () => {},
      onStream: () => () => {},
    }
    const iterator = new DesktopApiClient(bridge).events.mux({}, controller.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    // One cancellation from the pre-aborted path plus the iterator's normal
    // finally-side physical unsubscribe.
    expect(cancellations).toBe(2)
  })
})
