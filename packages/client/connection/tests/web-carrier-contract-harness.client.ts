import type { RpcMessage } from '../src/client/api.ts'
import { approvalResponsePayloadSchema } from '@deepseek-ai/dsh-host-apiproxy/api/approvals.schema'
import { clientResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { WebApiClient } from '../src/client/web-api-client.ts'
import type {
  CarrierContractHarness, CarrierContractStream,
} from './carrier-contract.client.ts'

type MutableGlobal = {
  location?: { origin: string }
  WebSocket?: typeof WebSocket
}

const global = globalThis as MutableGlobal

class ContractWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = ContractWebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    sockets.push(this)
  }

  open(): void {
    if (this.readyState !== ContractWebSocket.CONNECTING) return
    this.readyState = ContractWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  close(): void {
    if (this.readyState === ContractWebSocket.CLOSED) return
    this.readyState = ContractWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  receive(message: unknown): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message)
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

let sockets: ContractWebSocket[] = []

function streamFor(socket: ContractWebSocket): CarrierContractStream | undefined {
  const pathname = new URL(socket.url).pathname
  if (pathname === '/api/events.mux') return 'mux'
  if (pathname === '/api/events.host') return 'host'
  return undefined
}

function aborted(signal: AbortSignal): Promise<never> {
  const reason = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason === undefined ? 'contract request aborted' : String(signal.reason))
  if (signal.aborted) return Promise.reject(reason())
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => { reject(reason()) }, { once: true })
  })
}

/** HTTP/WebSocket adapter for the transport-neutral carrier contract. */
export async function createWebCarrierContractHarness(): Promise<CarrierContractHarness> {
  const originalFetch = globalThis.fetch
  const originalWebSocket = global.WebSocket
  const originalLocation = global.location
  const pendingResponses = new Set<string>()
  let completePendingReadiness: (() => void) | undefined
  sockets = []

  global.location = { origin: 'http://contract.local' }
  global.WebSocket = ContractWebSocket as unknown as typeof WebSocket
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.href : input instanceof Request ? input.url : input)
    if (typeof init?.body !== 'string') return new Response('missing body', { status: 400 })
    const message = JSON.parse(init.body) as RpcMessage
    if (url.pathname === '/api/respond') {
      const parsed = clientResponseSchema.safeParse(message)
      if (!parsed.success || !parsed.data.result.ok
        || !approvalResponsePayloadSchema.safeParse(parsed.data.result.value).success) {
        return Response.json({ accepted: false, reason: 'bad-response' })
      }
      const accepted = pendingResponses.delete(parsed.data.rpcId)
      return Response.json(accepted ? { accepted: true } : { accepted: false, reason: 'not-pending' })
    }
    if (message.type !== 'client-request') return new Response('bad envelope', { status: 400 })
    if (message.method === 'session.search' && (message.payload as { query?: unknown }).query === 'hang') {
      const signal = init.signal
      if (signal === null || signal === undefined) return new Promise(() => {})
      return aborted(signal)
    }
    if (message.method === 'session.list') {
      return Response.json({
        type: 'server-response',
        rpcId: message.rpcId,
        result: { ok: true, value: { items: [] } },
      })
    }
    if (message.method === 'session.history') {
      const sessionId = (message.payload as { sessionId: string }).sessionId
      return Response.json({
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
      })
    }
    if (message.method === 'host.describe') {
      return new Promise<Response>((resolve) => {
        completePendingReadiness = () => {
          resolve(Response.json({
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
          }))
        }
      })
    }
    return new Response('unknown contract method', { status: 404 })
  }

  const completeReadinessUnary = (): void => {
    if (completePendingReadiness === undefined) {
      throw new Error('contract readiness unary request is not pending')
    }
    completePendingReadiness()
    completePendingReadiness = undefined
  }

  const closeAll = (): void => {
    for (const socket of sockets) socket.close()
  }

  return {
    api: new WebApiClient(),
    completeReadinessUnary,
    open(stream) {
      const socket = sockets.find(candidate => streamFor(candidate) === stream
        && candidate.readyState === ContractWebSocket.CONNECTING)
      if (socket === undefined) throw new Error(`contract ${stream} subscription is not pending`)
      socket.open()
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
      const socket = sockets.find(candidate => streamFor(candidate) === stream
        && candidate.readyState === ContractWebSocket.OPEN)
      if (socket === undefined) throw new Error(`contract ${stream} subscription is not open`)
      socket.receive(message)
    },
    disconnect: closeAll,
    activeSubscriptions: () => sockets.filter(socket => socket.readyState !== ContractWebSocket.CLOSED).length,
    dispose() {
      closeAll()
      sockets = []
      globalThis.fetch = originalFetch
      if (originalWebSocket === undefined) delete global.WebSocket
      else global.WebSocket = originalWebSocket
      if (originalLocation === undefined) delete global.location
      else global.location = originalLocation
      return Promise.resolve()
    },
  }
}
