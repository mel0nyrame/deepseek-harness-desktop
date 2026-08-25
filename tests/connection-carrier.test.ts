import { expect, it, vi } from 'vitest'
import {
  DESKTOP_STREAM_QUEUE_LIMIT,
  DesktopApiClient,
  type ConnectionHandle,
  type ConnectionTransport,
  type DesktopBridge,
  type DesktopBridgeRequest,
  type DesktopStreamEvent,
  type RpcMessage,
} from '../packages/connection/src/carrier.js'
import {
  runCarrierContract,
  type CarrierContractHarness,
  type CarrierContractStream,
} from './connection-carrier-contract.js'

interface OfficialClientExports {
  createConnectionHandle(transport: ConnectionTransport): ConnectionHandle
  createFetchConnectionRpc(fetcher: typeof fetch): unknown
}

async function loadOfficialClientExports(): Promise<OfficialClientExports> {
  let exports: OfficialClientExports | undefined
  const window = {
    __ModuleLoader__: {
      load(module: { factory(require: (id: string) => unknown): OfficialClientExports }) {
        exports = module.factory((id) => { throw new Error(`unexpected client dependency: ${id}`) })
        return exports
      },
    },
  }
  Object.assign(globalThis, { window })
  const entry = new URL('../packages/connection/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js', import.meta.url)
  await import(`${entry.href}?connection-carrier-contract`)
  if (exports === undefined) throw new Error('official Client bundle did not register its exports')
  return exports
}

const officialClient = await loadOfficialClientExports()

it('publishes only the generic replacement seams added by the exact-version patch', () => {
  expect(officialClient.createConnectionHandle).toEqual(expect.any(Function))
  expect(officialClient.createFetchConnectionRpc).toEqual(expect.any(Function))
})

function aborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

async function createDesktopCarrierContractHarness(): Promise<CarrierContractHarness> {
  const listeners = new Set<(event: DesktopStreamEvent) => void>()
  const subscriptions = new Map<string, CarrierContractStream>()
  const opened = new Set<string>()
  const pendingResponses = new Set<string>()
  const pendingRequests = new Map<string, AbortController>()
  let completePendingReadiness: (() => void) | undefined

  const publish = (event: DesktopStreamEvent): void => {
    for (const listener of listeners) listener(event)
  }

  const bridge: DesktopBridge = {
    async request(request: DesktopBridgeRequest) {
      const controller = new AbortController()
      pendingRequests.set(request.id, controller)
      try {
        const message = JSON.parse(request.body ?? 'null') as RpcMessage
        if (new URL(request.url).pathname === '/api/respond') {
          const response = message.type === 'client-response' ? message : undefined
          const value = response?.result.ok === true ? response.result.value as Record<string, unknown> : undefined
          if (response === undefined || value === undefined
            || value['sessionId'] !== 'contract-session'
            || value['approvalId'] !== 'approval-1'
            || value['outcome'] !== 'allowed-once') {
            return { status: 200, headers: [], body: JSON.stringify({ accepted: false, reason: 'bad-response' }) }
          }
          const accepted = pendingResponses.delete(response.rpcId)
          return {
            status: 200,
            headers: [['content-type', 'application/json']],
            body: JSON.stringify(accepted ? { accepted: true } : { accepted: false, reason: 'not-pending' }),
          }
        }
        if (message.type !== 'client-request') return { status: 400, headers: [], body: 'bad envelope' }
        if (message.method === 'session.search' && (message.payload as { query?: unknown }).query === 'hang') {
          return await aborted(controller.signal)
        }
        if (message.method === 'session.list') {
          return {
            status: 200,
            headers: [['content-type', 'application/json']],
            body: JSON.stringify({
              type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { items: [] } },
            }),
          }
        }
        if (message.method === 'session.history') {
          const sessionId = (message.payload as { sessionId: string }).sessionId
          return {
            status: 200,
            headers: [['content-type', 'application/json']],
            body: JSON.stringify({
              type: 'server-response',
              rpcId: message.rpcId,
              result: {
                ok: false,
                error: {
                  code: 'session-not-found', message: 'contract session is absent', details: { sessionId },
                },
              },
            }),
          }
        }
        if (message.method === 'host.describe') {
          return await new Promise(resolve => {
            completePendingReadiness = () => {
              resolve({
                status: 200,
                headers: [['content-type', 'application/json']],
                body: JSON.stringify({
                  type: 'server-response',
                  rpcId: message.rpcId,
                  result: {
                    ok: true,
                    value: {
                      version: 'contract', cwd: '/contract', attachedSessions: 0, home: '/contract', canOpenPath: false,
                    },
                  },
                }),
              })
            }
          })
        }
        return { status: 404, headers: [], body: 'unknown contract method' }
      } finally {
        pendingRequests.delete(request.id)
      }
    },
    cancelRequest(id) {
      pendingRequests.get(id)?.abort(new Error('contract unary cancelled'))
    },
    subscribe(id, stream) {
      subscriptions.set(id, stream)
    },
    cancelSubscription(id) {
      if (!subscriptions.delete(id)) return
      opened.delete(id)
      publish({ type: 'end', id })
    },
    ackStream() {},
    onStream(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  return {
    api: new DesktopApiClient(bridge),
    completeReadinessUnary() {
      if (completePendingReadiness === undefined) throw new Error('readiness unary request is not pending')
      completePendingReadiness()
      completePendingReadiness = undefined
    },
    open(stream) {
      const id = [...subscriptions].find(([candidate, kind]) => kind === stream && !opened.has(candidate))?.[0]
      if (id === undefined) throw new Error(`${stream} subscription is not pending`)
      opened.add(id)
      publish({ type: 'open', id })
    },
    emit(stream, message) {
      if (typeof message === 'object' && message !== null) {
        const envelope = message as Partial<RpcMessage>
        if (envelope.type === 'server-request' && envelope.method === 'approval/requested'
          && typeof envelope.rpcId === 'string') pendingResponses.add(envelope.rpcId)
      }
      const id = [...subscriptions].find(([candidate, kind]) => kind === stream && opened.has(candidate))?.[0]
      if (id === undefined) throw new Error(`${stream} subscription is not open`)
      publish({ type: 'message', id, message })
    },
    disconnect() {
      for (const id of subscriptions.keys()) {
        subscriptions.delete(id)
        opened.delete(id)
        publish({ type: 'end', id })
      }
    },
    activeSubscriptions: () => subscriptions.size,
    dispose() {
      for (const controller of pendingRequests.values()) controller.abort()
      subscriptions.clear()
      opened.clear()
      listeners.clear()
      return Promise.resolve()
    },
  }
}

runCarrierContract(
  'desktop IPC',
  createDesktopCarrierContractHarness,
  transport => officialClient.createConnectionHandle(transport as unknown as ConnectionTransport),
)

it('bounds an unconsumed desktop stream queue and cancels its subscription', async () => {
  const listeners = new Set<(event: DesktopStreamEvent) => void>()
  let subscribedId: string | undefined
  const cancellations: string[] = []
  const bridge: DesktopBridge = {
    request: () => Promise.reject(new Error('not used')),
    cancelRequest() {},
    subscribe(id) { subscribedId = id },
    cancelSubscription(id) { cancellations.push(id) },
    ackStream() {},
    onStream(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const abort = new AbortController()
  const stream = new DesktopApiClient(bridge).events.mux({}, abort.signal)[Symbol.asyncIterator]()
  const first = stream.next()
  await vi.waitFor(() => { expect(subscribedId).toEqual(expect.any(String)) })
  const id = subscribedId as string
  for (const listener of listeners) listener({ type: 'open', id })
  for (let index = 0; index <= DESKTOP_STREAM_QUEUE_LIMIT; index += 1) {
    for (const listener of listeners) {
      listener({
        type: 'message', id,
        message: {
          type: 'server-request', rpcId: `queued-${String(index)}`, method: 'session/subscribed',
          payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: index },
        },
      })
    }
  }
  await expect(first).rejects.toThrow(`queue limit of ${String(DESKTOP_STREAM_QUEUE_LIMIT)} frames exceeded`)
  expect(cancellations).toContain(id)
})
