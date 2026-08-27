/// <reference lib="dom" />

import type { DesktopBridge } from '@dsh-desktop/connection/carrier'
import { TERMINAL_TRACER_PROMPT } from './tracer-contract.js'

declare global {
  interface Window {
    readonly dshDesktop: DesktopBridge
  }
}

interface Frame {
  readonly type: string
  readonly seq?: number
  readonly data?: Record<string, unknown>
}

interface RpcResult {
  readonly ok: boolean
  readonly value?: Record<string, unknown>
  readonly error?: { readonly message?: unknown }
}

const status = document.querySelector<HTMLElement>('#status')
const result = document.querySelector<HTMLElement>('#result')

function render(state: string, message: string): void {
  if (status === null || result === null) throw new Error('desktop tracer document is incomplete')
  document.body.dataset.state = state
  status.textContent = state === 'complete' ? 'Integrated runtime ready' : 'Running integrated runtime tracer…'
  result.textContent = message
  result.hidden = false
}

function toolResultText(events: readonly Frame[]): string {
  const event = events.findLast(candidate => candidate.type === 'tool/result')
  const message = event?.data?.['message'] as { content?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> } | undefined
  return message?.content?.flatMap(part => part.content ?? []).map(part => part.text ?? '').join('') ?? ''
}

async function unary(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID()
  const response = await window.dshDesktop.request({
    id,
    url: `dsh://app/api/${method}`,
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
  })
  if (response.status !== 200) throw new Error(`${method} returned HTTP ${String(response.status)}`)
  const envelope = JSON.parse(response.body) as { type?: unknown; rpcId?: unknown; result?: RpcResult }
  if (envelope.type !== 'server-response' || envelope.rpcId !== id || envelope.result === undefined) {
    throw new Error(`${method} returned an invalid response envelope`)
  }
  if (!envelope.result.ok) throw new Error(String(envelope.result.error?.message ?? `${method} failed`))
  return envelope.result.value ?? {}
}

async function runTracer(): Promise<void> {
  const records: Array<{ method: string; payload: Record<string, unknown> }> = []
  const subscriptionId = crypto.randomUUID()
  let streamFailure: Error | undefined
  let openStream!: () => void
  const opened = new Promise<void>(resolve => { openStream = resolve })
  const unsubscribe = window.dshDesktop.onStream((event) => {
    if (event.id !== subscriptionId) return
    if (event.type === 'open') openStream()
    else if (event.type === 'message') {
      const envelope = event.message as { method?: unknown; payload?: unknown }
      if (typeof envelope.method === 'string' && typeof envelope.payload === 'object' && envelope.payload !== null) {
        records.push({ method: envelope.method, payload: envelope.payload as Record<string, unknown> })
      }
    } else if (event.type === 'error') streamFailure = new Error(event.message)
    else if (event.type === 'end' && streamFailure === undefined) streamFailure = new Error('terminal tracer mux stream ended')
    window.dshDesktop.ackStream(subscriptionId)
  })
  window.dshDesktop.subscribe(subscriptionId, 'mux')
  await opened
  const created = await unary('session.create', {})
  const sessionId = created['sessionId']
  if (typeof sessionId !== 'string') throw new Error('session.create returned no session id')
  const prompted = await unary('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: TERMINAL_TRACER_PROMPT }],
  })
  if (prompted['accepted'] !== true) throw new Error('terminal tracer prompt was not accepted')
  const deadline = Date.now() + 120_000
  for (;;) {
    const events = records
      .filter(record => record.method === 'session/event' && record.payload['sessionId'] === sessionId)
      .map(record => record.payload['event'] as Frame)
    const ended = events.findLast(event => event.type === 'turn/end')
    if (ended !== undefined) {
      const reason = ended.data?.['reason'] as { kind?: unknown } | undefined
      if (reason?.kind !== 'completed') throw new Error(`terminal tracer ended with ${JSON.stringify(reason)}`)
      const sequences = events.flatMap(event => event.seq === undefined ? [] : [event.seq])
      if (sequences.some((value, index) => index > 0 && value <= (sequences[index - 1] as number))) {
        throw new Error('terminal tracer event order is not monotonic')
      }
      if (!events.some(event => event.type === 'tool/call' && event.data?.['name'] === 'bash')) {
        throw new Error('terminal tracer did not call the bash tool')
      }
      if (!toolResultText(events).includes('TERMINAL_OK')) {
        throw new Error('terminal tracer did not observe TERMINAL_OK')
      }
      if (!events.some(event => event.type === 'assistant/message'
        && JSON.stringify(event.data?.['message']).includes('DONE'))) {
        throw new Error('terminal tracer did not observe DONE')
      }
      const history = await unary('session.history', { sessionId, maxMessages: 50 })
      if (!JSON.stringify(history).includes(TERMINAL_TRACER_PROMPT)
        || !JSON.stringify(history).includes('TERMINAL_OK')) {
        throw new Error('terminal tracer session log is not reconstructable')
      }
      render('complete', 'TERMINAL_OK\nDONE')
      window.dshDesktop.cancelSubscription(subscriptionId)
      unsubscribe()
      return
    }
    if (streamFailure !== undefined) throw streamFailure
    if (Date.now() > deadline) throw new Error('terminal tracer timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function runNativeJourney(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const expectedPick = params.get('pick')
  const expectedOpen = params.get('open')
  if (expectedPick === null || expectedOpen === null) throw new Error('native journey query is incomplete')

  render('starting', `Selecting ${expectedPick}`)
  const picked = await unary('host.pickDirectory', {})
  if (picked['path'] !== expectedPick) {
    throw new Error(`host.pickDirectory returned ${JSON.stringify(picked['path'] ?? null)} instead of the requested directory`)
  }
  document.body.dataset.state = 'picked'
  if (result !== null) {
    result.textContent = `NATIVE_PICK ${expectedPick}`
    result.hidden = false
  }

  await new Promise(resolve => setTimeout(resolve, 50))
  render('opening', `Opening ${expectedOpen}`)
  const opened = await unary('host.openPath', { path: expectedOpen })
  if (opened['opened'] !== true) throw new Error('host.openPath did not confirm the native handoff')

  render('complete', `NATIVE_PICK ${expectedPick}\nNATIVE_OPENED ${expectedOpen}`)
}

if (new URLSearchParams(location.search).get('tracer') === '1') {
  void runTracer().catch((error: unknown) => {
    render('failed', error instanceof Error ? error.message : String(error))
  })
} else if (new URLSearchParams(location.search).get('tracer') === 'native') {
  void runNativeJourney().catch((error: unknown) => {
    render('failed', error instanceof Error ? error.message : String(error))
  })
} else {
  render('ready', 'DSH Desktop')
}
