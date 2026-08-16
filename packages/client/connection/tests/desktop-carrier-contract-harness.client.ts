import type { RpcMessage } from '../src/client/api.ts'
import { approvalResponsePayloadSchema } from '@deepseek-ai/dsh-host-apiproxy/api/approvals.schema'
import { clientResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import {
  DesktopApiClient,
  type DesktopBridge,
  type DesktopBridgeRequest,
  type DesktopStreamEvent,
} from '../src/client/desktop-api-client.ts'
import type {
  CarrierContractHarness, CarrierContractStream,
} from './carrier-contract.client.ts'

function aborted(signal: AbortSignal): Promise<never> {
  const reason = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason === undefined ? 'contract request aborted' : String(signal.reason))
  if (signal.aborted) return Promise.reject(reason())
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => { reject(reason()) }, { once: true })
  })
}

/** IPC-shaped adapter for the transport-neutral carrier contract. */
export async function createDesktopCarrierContractHarness(): Promise<CarrierContractHarness> {
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
          const parsed = clientResponseSchema.safeParse(message)
          const value = parsed.success && parsed.data.result.ok
            ? approvalResponsePayloadSchema.safeParse(parsed.data.result.value)
            : undefined
          if (!parsed.success
            || !parsed.data.result.ok
            || value === undefined || !value.success
            || value.data.sessionId !== 'contract-session'
            || value.data.approvalId !== 'approval-1'
            || value.data.outcome !== 'allowed-once') {
            return { status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify({ accepted: false, reason: 'bad-response' }) }
          }
          const accepted = pendingResponses.delete(parsed.data.rpcId)
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
                  code: 'session-not-found',
                  message: 'contract session is absent',
                  details: { sessionId },
                },
              },
            }),
          }
        }
        if (message.method === 'host.describe') {
          return await new Promise((resolve) => {
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
                      version: 'contract',
                      cwd: '/contract',
                      attachedSessions: 0,
                      canOpenPath: false,
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

  const completeReadinessUnary = (): void => {
    if (completePendingReadiness === undefined) {
      throw new Error('contract readiness unary request is not pending')
    }
    completePendingReadiness()
    completePendingReadiness = undefined
  }

  return {
    api: new DesktopApiClient(bridge),
    completeReadinessUnary,
    open(stream) {
      const id = [...subscriptions].find(([candidate, kind]) => kind === stream && !opened.has(candidate))?.[0]
      if (id === undefined) throw new Error(`contract ${stream} subscription is not pending`)
      opened.add(id)
      publish({ type: 'open', id })
    },
    emit(stream, message) {
      if (typeof message === 'object' && message !== null) {
        const envelope = message as Partial<RpcMessage>
        if (envelope.type === 'server-request'
          && envelope.method === 'approval/requested'
          && typeof envelope.rpcId === 'string') {
          pendingResponses.add(envelope.rpcId)
        }
      }
      const id = [...subscriptions].find(([candidate, kind]) => kind === stream && opened.has(candidate))?.[0]
      if (id === undefined) throw new Error(`contract ${stream} subscription is not open`)
      publish({ type: 'message', id, message })
    },
    disconnect() {
      for (const id of [...subscriptions.keys()]) {
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
