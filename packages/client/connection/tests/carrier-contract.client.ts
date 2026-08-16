/**
 * Transport-neutral conformance suite for Client Connection carriers.
 *
 * A carrier supplies only controls that any test adapter can provide: create a
 * client, deliver an untrusted message to either logical stream, disconnect,
 * and report live subscriptions. The contract deliberately names no browser,
 * network, Electron, or IPC primitive.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IApiClient, RpcMessage } from '../src/client/api.ts'
import { RpcId } from '../src/client/api.ts'
import { ConnectionController } from '../src/client/connection.ts'

export type CarrierContractStream = 'mux' | 'host'

/** One fresh carrier instance controlled at its transport-neutral test seam. */
export interface CarrierContractHarness {
  readonly api: IApiClient
  /** Complete the unary request used by the readiness handshake. */
  completeReadinessUnary(): void
  /** Complete establishment of one pending logical stream. */
  open(stream: CarrierContractStream): void
  /** Deliver one untrusted transport message to a logical stream. */
  emit(stream: CarrierContractStream, message: unknown): void
  /** End every live subscription as an unexpected carrier disconnect. */
  disconnect(): void
  /** Number of transport subscriptions that still retain resources. */
  activeSubscriptions(): number
  /** Release the carrier and restore any test-owned process state. */
  dispose(): Promise<void>
}

/** Factory contract: each call returns an isolated, disconnected carrier. */
export type CarrierContractFactory = () => Promise<CarrierContractHarness>

async function usingHarness(
  make: CarrierContractFactory,
  run: (harness: CarrierContractHarness) => Promise<void>,
): Promise<void> {
  const harness = await make()
  try {
    await run(harness)
  } finally {
    await harness.dispose()
  }
}

function muxMessage(rpcId: string, lastSeq: number): RpcMessage {
  return {
    type: 'server-request',
    rpcId: RpcId(rpcId),
    method: 'session/subscribed',
    payload: { type: 'session/subscribed', sessionId: 'contract-session', lastSeq },
  }
}

function hostMessage(rpcId: string): RpcMessage {
  return {
    type: 'server-request',
    rpcId: RpcId(rpcId),
    method: 'host/remote-event',
    payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
  }
}

/** Run every behavior required of a Client Connection carrier. */
export function runCarrierContract(name: string, make: CarrierContractFactory): void {
  describe(`Client Connection carrier contract: ${name}`, () => {
    it('carries unary success and business-failure envelopes', async () => {
      await usingHarness(make, async ({ api }) => {
        const success = await api.sessions.list({})
        expect(success.rpcId).toEqual(expect.any(String))
        expect(success.result).toEqual({ ok: true, value: { items: [] } })

        const failure = await api.sessions.history({ sessionId: 'missing' as never })
        expect(failure.result).toEqual({
          ok: false,
          error: {
            code: 'session-not-found',
            message: 'contract session is absent',
            details: { sessionId: 'missing' },
          },
        })
      })
    })

    it('echoes a Host request rpcId in the Client response and bounds duplicate lifetime', async () => {
      await usingHarness(make, async (harness) => {
        const abort = new AbortController()
        const stream = harness.api.events.mux({}, abort.signal)[Symbol.asyncIterator]()
        const frame = stream.next()
        await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(1) })
        harness.open('mux')
        harness.emit('mux', {
          type: 'server-request',
          rpcId: 'contract-response',
          method: 'approval/requested',
          payload: {
            type: 'approval/requested',
            sessionId: 'contract-session',
            approvalId: 'approval-1',
            toolName: 'bash',
          },
        })
        const request = await frame
        if (request.done) throw new Error('contract stream ended before the Host request')
        expect(request.value.rpcId).toBe('contract-response')

        const response = {
          type: 'client-response' as const,
          rpcId: request.value.rpcId,
          result: {
            ok: true as const,
            value: { sessionId: 'contract-session', approvalId: 'approval-1', outcome: 'allowed-once' },
          },
        }
        await expect(harness.api.respond(response)).resolves.toEqual({ accepted: true })
        await expect(harness.api.respond(response)).resolves.toEqual({ accepted: false, reason: 'not-pending' })
        abort.abort()
      })
    })

    it('opens both logical streams before readiness and preserves independent ordering', async () => {
      await usingHarness(make, async (harness) => {
        const abort = new AbortController()
        const opened: CarrierContractStream[] = []
        const mux = harness.api.events.mux({}, abort.signal, () => { opened.push('mux') })[Symbol.asyncIterator]()
        const host = harness.api.events.host({}, abort.signal, () => { opened.push('host') })[Symbol.asyncIterator]()
        const firstMux = mux.next()
        const firstHost = host.next()

        await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(2) })
        harness.open('mux')
        harness.open('host')
        expect(opened).toEqual(['mux', 'host'])
        expect(harness.activeSubscriptions()).toBe(2)
        harness.emit('mux', muxMessage('mux-1', 1))
        harness.emit('host', hostMessage('host-1'))
        harness.emit('mux', muxMessage('mux-2', 2))
        harness.emit('host', hostMessage('host-2'))

        await expect(firstMux).resolves.toMatchObject({ value: { rpcId: 'mux-1' } })
        await expect(mux.next()).resolves.toMatchObject({ value: { rpcId: 'mux-2' } })
        await expect(firstHost).resolves.toMatchObject({ value: { rpcId: 'host-1' } })
        await expect(host.next()).resolves.toMatchObject({ value: { rpcId: 'host-2' } })
        abort.abort()
      })
    })

    it.each([
      { pending: 'mux' as const, first: 'host' as const },
      { pending: 'host' as const, first: 'mux' as const },
    ])('waits for the $pending stream before publishing readiness', async ({ pending, first }) => {
      await usingHarness(make, async (harness) => {
        const connected = Promise.withResolvers<undefined>()
        let connectedWith: unknown
        let subscriptionsAtReadiness = 0
        const controller = new ConnectionController(harness.api, {
          onConnected(description) {
            connectedWith = description
            subscriptionsAtReadiness = harness.activeSubscriptions()
            connected.resolve(undefined)
          },
        }, { streamOpenTimeoutMs: 1_000 })
        controller.start()
        try {
          await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(2) })
          harness.completeReadinessUnary()
          harness.open(first)
          await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
          expect(connectedWith).toBeUndefined()
          harness.open(pending)
          await connected.promise
          expect(connectedWith).toEqual({
            version: 'contract',
            cwd: '/contract',
            attachedSessions: 0,
            canOpenPath: false,
          })
          expect(subscriptionsAtReadiness).toBe(2)
        } finally {
          controller.stop()
        }
        await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(0) })
      })
    })

    it('waits for unary reachability after both streams are open', async () => {
      await usingHarness(make, async (harness) => {
        const connected = Promise.withResolvers<undefined>()
        let isConnected = false
        const controller = new ConnectionController(harness.api, {
          onConnected() {
            isConnected = true
            connected.resolve(undefined)
          },
        }, { streamOpenTimeoutMs: 1_000 })
        controller.start()
        try {
          await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(2) })
          harness.open('mux')
          harness.open('host')
          await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
          expect(isConnected).toBe(false)
          harness.completeReadinessUnary()
          await connected.promise
          expect(isConnected).toBe(true)
        } finally {
          controller.stop()
        }
        await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(0) })
      })
    })

    it('uses the configured readiness timeout when a stream never signals open', async () => {
      await usingHarness(make, async (harness) => {
        const connected = Promise.withResolvers<undefined>()
        const controller = new ConnectionController(harness.api, {
          onConnected() { connected.resolve(undefined) },
        }, { streamOpenTimeoutMs: 10 })
        controller.start()
        try {
          await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(2) })
          harness.completeReadinessUnary()
          harness.open('mux')
          await connected.promise
          expect(harness.activeSubscriptions()).toBe(2)
        } finally {
          controller.stop()
        }
        await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(0) })
      })
    })

    it.each([
      {
        stream: 'mux' as const,
        malformed: { type: 'server-request', rpcId: 'bad-mux', method: 'session/subscribed', payload: {} },
        valid: muxMessage('mux-after-malformed', 3),
      },
      {
        stream: 'host' as const,
        malformed: { type: 'server-request', rpcId: 'bad-host', method: 'host/remote-event', payload: {} },
        valid: hostMessage('host-after-malformed'),
      },
    ])('drops malformed messages on $stream without ending the subscription', async ({ stream, malformed, valid }) => {
      await usingHarness(make, async (harness) => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        try {
          const abort = new AbortController()
          const events = harness.api.events[stream]({}, abort.signal)[Symbol.asyncIterator]()
          const next = events.next()
          await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(1) })
          harness.open(stream)
          harness.emit(stream, '{')
          harness.emit(stream, malformed)
          harness.emit(stream, valid)
          await expect(next).resolves.toMatchObject({ value: { rpcId: valid.rpcId } })
          expect(error).toHaveBeenCalledTimes(2)
          abort.abort()
        } finally {
          error.mockRestore()
        }
      })
    })

    it('propagates unary cancellation and releases an aborted subscription', async () => {
      await usingHarness(make, async (harness) => {
        const unaryAbort = new AbortController()
        const pendingUnary = harness.api.sessions.search({ query: 'hang' }, unaryAbort.signal)
        const reason = new Error('contract unary cancelled')
        unaryAbort.abort(reason)
        await expect(pendingUnary).rejects.toBe(reason)

        const streamAbort = new AbortController()
        const stream = harness.api.events.host({}, streamAbort.signal)[Symbol.asyncIterator]()
        const end = stream.next()
        await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(1) })
        harness.open('host')
        streamAbort.abort()
        await expect(end).resolves.toMatchObject({ done: true })
        expect(harness.activeSubscriptions()).toBe(0)
      })
    })

    it('ends every subscription on disconnect and cleans up repeated subscription lifetimes', async () => {
      await usingHarness(make, async (harness) => {
        const abort = new AbortController()
        const mux = harness.api.events.mux({}, abort.signal)[Symbol.asyncIterator]()
        const host = harness.api.events.host({}, abort.signal)[Symbol.asyncIterator]()
        const muxEnd = mux.next()
        const hostEnd = host.next()
        await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(2) })
        harness.open('mux')
        harness.open('host')

        harness.disconnect()
        await expect(muxEnd).resolves.toMatchObject({ done: true })
        await expect(hostEnd).resolves.toMatchObject({ done: true })
        expect(harness.activeSubscriptions()).toBe(0)

        for (let index = 0; index < 3; index += 1) {
          const cycleAbort = new AbortController()
          const cycle = harness.api.events.mux({}, cycleAbort.signal)[Symbol.asyncIterator]()
          const cycleEnd = cycle.next()
          await vi.waitFor(() => { expect(harness.activeSubscriptions()).toBe(1) })
          harness.open('mux')
          cycleAbort.abort()
          await expect(cycleEnd).resolves.toMatchObject({ done: true })
          expect(harness.activeSubscriptions()).toBe(0)
        }
      })
    })
  })
}
