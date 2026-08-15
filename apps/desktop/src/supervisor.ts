/** Electron-main ownership of one application-scoped DSH child. */

import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  DesktopChildMessage,
  DesktopNativeRequest,
  DesktopNativeResult,
  DesktopParentMessage,
} from '@deepseek-ai/dsh-desktop-app'
import type { ProcessTreeLadder, ProcessTreeSnapshot } from './process-tree.ts'

type ReadyMessage = Extract<DesktopChildMessage, { type: 'ready' }>
type ResponseMessage = Extract<DesktopChildMessage, { type: 'response' }>
type RequestErrorMessage = Extract<DesktopChildMessage, { type: 'request-error' }>
type NativeMessage = Extract<DesktopChildMessage, { type: 'native-request' | 'cancel-native-request' }>
type StreamMessage = Exclude<DesktopChildMessage, ReadyMessage | ResponseMessage | RequestErrorMessage | NativeMessage>

/** Electron-main implementation of the two native actions exposed to DSH. */
export type DesktopNativeActionHandler = (
  request: DesktopNativeRequest,
  signal: AbortSignal,
) => Promise<DesktopNativeResult>

/** Child-process surface used by the supervisor and its tests. */
export interface DshChild {
  readonly pid: number | undefined
  readonly connected: boolean
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  send(message: DesktopParentMessage, callback?: (error: Error | null) => void): boolean
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'disconnect', listener: () => void): this
  off(event: 'message', listener: (message: unknown) => void): this
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  off(event: 'error', listener: (error: Error) => void): this
  off(event: 'disconnect', listener: () => void): this
}

/** Configured supervisor deadlines. */
export interface SupervisorOptions {
  readonly startupTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly bundleRoot?: string
  /** Process-tree termination ladder; without one, stop joins the child only. */
  readonly tree?: ProcessTreeLadder
  /** Grace the ladder allows each escalation stage before escalating again. */
  readonly treeGraceMs?: number
  /** Refresh interval for the pre-exit ownership snapshot kept for crash recovery. */
  readonly treeSnapshotMs?: number
}

interface PendingRequest {
  resolve(message: ResponseMessage): void
  reject(error: Error): void
}

interface SubscriptionState {
  readonly stream: 'mux' | 'host'
  cancelling: boolean
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000
const DEFAULT_TREE_GRACE_MS = 1_000
const DEFAULT_TREE_SNAPSHOT_MS = 1_000

type SendResult =
  | { readonly kind: 'accepted' | 'backpressured' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed'; readonly error: Error }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseHeaders(value: unknown): Array<readonly [string, string]> | undefined {
  if (!Array.isArray(value)) return undefined
  const headers: Array<readonly [string, string]> = []
  for (const header of value) {
    if (!Array.isArray(header) || header.length !== 2
      || typeof header[0] !== 'string' || typeof header[1] !== 'string') return undefined
    headers.push([header[0], header[1]])
  }
  return headers
}

function bundlePathWithin(root: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !isAbsolute(value) || extname(value) !== '.js') return undefined
  try {
    const canonicalRoot = realpathSync(root)
    const canonicalPath = realpathSync(value)
    const rel = relative(canonicalRoot, canonicalPath)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
    if (!statSync(canonicalPath).isFile()) return undefined
    return canonicalPath
  } catch (_error: unknown) {
    // A missing, unreadable, or link-escaped file is invalid child wire input.
    return undefined
  }
}

function parseReadyMessage(value: Record<string, unknown>, bundleRoot: string): ReadyMessage | undefined {
  if (!isRecord(value.graph) || typeof value.graph.rev !== 'string' || !Array.isArray(value.graph.entries)) return undefined
  const entries: ReadyMessage['graph']['entries'] = []
  for (const entry of value.graph.entries) {
    if (!isRecord(entry)
      || typeof entry.id !== 'string'
      || typeof entry.url !== 'string'
      || typeof entry.rev !== 'string'
      || (entry.inject !== undefined
        && (!Array.isArray(entry.inject) || entry.inject.some(item => typeof item !== 'string')))
      || (entry.immediately !== undefined && typeof entry.immediately !== 'boolean')) return undefined
    entries.push({
      id: entry.id,
      url: entry.url,
      rev: entry.rev,
      ...(entry.inject === undefined ? {} : { inject: [...entry.inject as string[]] }),
      ...(entry.immediately === undefined ? {} : { immediately: entry.immediately }),
    })
  }
  if (!Array.isArray(value.bundles)) return undefined
  const bundles: ReadyMessage['bundles'][number][] = []
  for (const bundle of value.bundles) {
    if (!isRecord(bundle) || !isId(bundle.id)) return undefined
    const path = bundlePathWithin(bundleRoot, bundle.path)
    if (path === undefined) return undefined
    bundles.push({ id: bundle.id, path })
  }
  const entryIds = entries.map(entry => entry.id)
  const bundleIds = bundles.map(bundle => bundle.id)
  if (new Set(entryIds).size !== entryIds.length
    || new Set(bundleIds).size !== bundleIds.length
    || entryIds.length !== bundleIds.length
    || entryIds.some(id => !bundleIds.includes(id))) return undefined
  return { type: 'ready', graph: { rev: value.graph.rev, entries }, bundles }
}

/** Validate one untrusted child-process message before correlation or stream dispatch. */
export function parseDesktopChildMessage(value: unknown, bundleRoot = process.cwd()): DesktopChildMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  if (value.type === 'ready') return parseReadyMessage(value, resolve(bundleRoot))
  if (!isId(value.id)) return undefined
  switch (value.type) {
    case 'response': {
      const headers = parseHeaders(value.headers)
      if (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599
        || headers === undefined || typeof value.body !== 'string') return undefined
      return { type: 'response', id: value.id, status: value.status as number, headers, body: value.body }
    }
    case 'request-error':
    case 'stream-error':
      return typeof value.message === 'string'
        ? { type: value.type, id: value.id, message: value.message }
        : undefined
    case 'stream-open':
    case 'stream-end':
      return { type: value.type, id: value.id }
    case 'stream-message':
      return Object.hasOwn(value, 'message')
        ? { type: 'stream-message', id: value.id, message: value.message }
        : undefined
    case 'native-request': {
      if (!isRecord(value.request) || typeof value.request.type !== 'string') return undefined
      if (value.request.type === 'pick-directory') {
        return { type: 'native-request', id: value.id, request: { type: 'pick-directory' } }
      }
      if (value.request.type === 'open-path' && typeof value.request.path === 'string') {
        return {
          type: 'native-request', id: value.id,
          request: { type: 'open-path', path: value.request.path },
        }
      }
      return undefined
    }
    case 'cancel-native-request':
      return { type: 'cancel-native-request', id: value.id }
    default:
      return undefined
  }
}

function malformedNativeRequestId(value: unknown): string | undefined {
  return isRecord(value) && value.type === 'native-request' && isId(value.id) ? value.id : undefined
}

function errorOf(message: RequestErrorMessage): Error {
  return new Error(`desktop DSH request ${message.id} failed: ${message.message}`)
}

/** Supervise one child from startup handshake through terminate-and-join. */
export class DshSupervisor {
  private readonly startupTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly bundleRoot: string
  private readonly tree: ProcessTreeLadder | undefined
  private readonly treeGraceMs: number
  private readonly treeSnapshotMs: number
  private latestSnapshot: ProcessTreeSnapshot | undefined
  private treeMonitor: ReturnType<typeof setInterval> | undefined
  private readonly ready = Promise.withResolvers<ReadyMessage>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly subscriptions = new Map<string, SubscriptionState>()
  private readonly queuedSubscriptions = new Map<'mux' | 'host', string>()
  private readonly streamListeners = new Set<(message: StreamMessage) => void>()
  private readonly exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>()
  private readonly nativeActions = new Map<string, AbortController>()
  private nativeActionHandler: DesktopNativeActionHandler | undefined
  private stopping: Promise<void> | undefined
  private settledReady = false
  private escalated = false

  constructor(private readonly child: DshChild, options: SupervisorOptions = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.treeGraceMs = options.treeGraceMs ?? DEFAULT_TREE_GRACE_MS
    this.treeSnapshotMs = options.treeSnapshotMs ?? DEFAULT_TREE_SNAPSHOT_MS
    this.tree = options.tree
    this.bundleRoot = resolve(options.bundleRoot ?? process.cwd())
    this.startTreeMonitor()
    void this.ready.promise.catch((_error: unknown) => {
      // Child failure can precede start(); start() remains the public observer.
    })
    child.on('message', this.onMessage)
    child.on('exit', this.handleChildExit)
    child.on('error', this.onError)
    child.on('disconnect', this.onDisconnect)
  }

  /** Wait for the child composition and client graph to settle. */
  async start(): Promise<ReadyMessage> {
    const timeout = setTimeout(() => {
      this.rejectReady(new Error(`desktop DSH child did not become ready within ${String(this.startupTimeoutMs)}ms`))
    }, this.startupTimeoutMs)
    try {
      return await this.ready.promise
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Send one unary request and correlate its response. */
  request(message: Extract<DesktopParentMessage, { type: 'request' }>): Promise<ResponseMessage> {
    if (this.pending.has(message.id)) return Promise.reject(new Error(`duplicate desktop request id ${message.id}`))
    if (!this.child.connected) return Promise.reject(new Error('desktop DSH child IPC channel is closed'))
    const result = Promise.withResolvers<ResponseMessage>()
    void result.promise.catch((_error: unknown) => {
      // A synchronous send failure may reject before the caller attaches await.
    })
    this.pending.set(message.id, result)
    const sent = this.send(message)
    if (sent.kind === 'closed' || sent.kind === 'failed') {
      this.pending.delete(message.id)
      result.reject(sent.kind === 'closed'
        ? new Error('desktop DSH child IPC channel is closed')
        : new Error(`desktop DSH child IPC send failed: ${sent.error.message}`))
    }
    return result.promise
  }

  /** Forward cancellation for a renderer-owned unary call. */
  cancelRequest(id: string): void {
    const pending = this.pending.get(id)
    if (pending !== undefined) {
      this.pending.delete(id)
      pending.reject(new Error(`desktop DSH request ${id} cancelled`))
    }
    this.cancelChildResource({ type: 'cancel-request', id })
  }

  /** Install the one Electron-main native-action handler for this child generation. */
  serveNativeActions(handler: DesktopNativeActionHandler): () => void {
    if (this.nativeActionHandler !== undefined) throw new Error('desktop native action handler is already installed')
    this.nativeActionHandler = handler
    return () => {
      if (this.nativeActionHandler !== handler) return
      this.nativeActionHandler = undefined
      this.abortNativeActions()
    }
  }

  /** Open one renderer-owned logical event stream. */
  subscribe(id: string, stream: 'mux' | 'host'): void {
    if (this.subscriptions.has(id)) {
      this.cancelSubscription(id)
      this.terminateRendererStream(id, 'duplicate subscription id')
      return
    }
    if ([...this.queuedSubscriptions.values()].includes(id)) {
      this.terminateRendererStream(id, 'duplicate subscription id')
      return
    }
    const active = [...this.subscriptions.entries()].find(([, state]) => state.stream === stream)
    if (active !== undefined) {
      if (active[1].cancelling && !this.queuedSubscriptions.has(stream)) {
        this.queuedSubscriptions.set(stream, id)
        return
      }
      this.terminateRendererStream(id, `duplicate ${stream} subscription`)
      return
    }
    this.openSubscription(id, stream)
  }

  /** Close one renderer-owned logical event stream. */
  cancelSubscription(id: string): void {
    for (const [stream, queuedId] of this.queuedSubscriptions) {
      if (queuedId === id) this.queuedSubscriptions.delete(stream)
    }
    const state = this.subscriptions.get(id)
    if (state === undefined || state.cancelling) return
    state.cancelling = true
    this.cancelChildResource({ type: 'cancel-subscription', id })
  }

  /** Cancel every resource owned by a renderer generation that ended or reloaded. */
  disconnectRenderer(): void {
    const requestIds = [...this.pending.keys()]
    const subscriptionIds = [...this.subscriptions.entries()]
      .filter(([, state]) => !state.cancelling)
      .map(([id]) => id)
    for (const id of requestIds) this.cancelChildResource({ type: 'cancel-request', id })
    for (const id of subscriptionIds) {
      const state = this.subscriptions.get(id)
      if (state !== undefined) state.cancelling = true
      this.cancelChildResource({ type: 'cancel-subscription', id })
    }
    this.failPending(new Error('desktop renderer disconnected'))
    this.queuedSubscriptions.clear()
  }

  /** Observe stream lifecycle messages for forwarding to the renderer. */
  onStream(listener: (message: StreamMessage) => void): () => void {
    this.streamListeners.add(listener)
    return () => { this.streamListeners.delete(listener) }
  }

  /** Observe child exit so the lifecycle owner can classify and recover. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }

  /** Ask the child to dispose its Cordis tree, then wait for process exit. */
  stop(): Promise<void> {
    this.stopping ??= this.stopOnce()
    return this.stopping
  }

  /** Whether shutdown had to escalate past the graceful SIGTERM stage. */
  get wasEscalated(): boolean {
    return this.escalated
  }

  private openSubscription(id: string, stream: 'mux' | 'host'): void {
    this.subscriptions.set(id, { stream, cancelling: false })
    const sent = this.send({ type: 'subscribe', id, stream })
    if (sent.kind === 'closed' || sent.kind === 'failed') {
      this.rejectSubscription(id, sent.kind === 'closed'
        ? 'desktop DSH child IPC channel is closed'
        : `desktop DSH child IPC send failed: ${sent.error.message}`)
    }
  }

  private rejectSubscription(id: string, message: string): void {
    this.subscriptions.delete(id)
    this.terminateRendererStream(id, message)
  }

  private terminateRendererStream(id: string, message: string): void {
    this.publishStream({ type: 'stream-error', id, message })
    this.publishStream({ type: 'stream-end', id })
  }

  private cancelChildResource(message: Extract<DesktopParentMessage, { type: 'cancel-request' | 'cancel-subscription' }>): void {
    const sent = this.send(message)
    if (sent.kind === 'closed' || sent.kind === 'failed') this.failClosed()
  }

  private failClosed(): void {
    void this.stop().catch((error: unknown) => {
      console.error('[desktop-supervisor] fail-closed child shutdown failed:', error)
    })
  }

  private send(message: DesktopParentMessage): SendResult {
    if (!this.child.connected) return { kind: 'closed' }
    try {
      const accepted = this.child.send(message, (error) => {
        if (error !== null) this.onSendError(message, error)
      })
      return { kind: accepted ? 'accepted' : 'backpressured' }
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error))
      console.error('[desktop-supervisor] child IPC send failed:', failure)
      return { kind: 'failed', error: failure }
    }
  }

  private readonly onMessage = (value: unknown): void => {
    const message = parseDesktopChildMessage(value, this.bundleRoot)
    if (message === undefined) {
      const id = malformedNativeRequestId(value)
      if (id !== undefined) {
        this.respondNative(id, {
          ok: false,
          error: { code: 'invalid-request', message: 'desktop native request is malformed' },
        })
        return
      }
      console.error('[desktop-supervisor] dropped malformed child IPC message')
      return
    }
    if (message.type === 'ready') {
      if (this.settledReady) return
      this.settledReady = true
      this.ready.resolve(message)
      return
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      pending.resolve(message)
      return
    }
    if (message.type === 'request-error') {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      pending.reject(errorOf(message))
      return
    }
    if (message.type === 'native-request') {
      this.handleNativeRequest(message)
      return
    }
    if (message.type === 'cancel-native-request') {
      const controller = this.nativeActions.get(message.id)
      if (controller !== undefined) {
        this.nativeActions.delete(message.id)
        controller.abort()
      }
      return
    }
    const subscription = this.subscriptions.get(message.id)
    if (subscription === undefined) return
    if (message.type === 'stream-end') {
      this.subscriptions.delete(message.id)
      if (!subscription.cancelling) this.publishStream(message)
      const successor = this.queuedSubscriptions.get(subscription.stream)
      if (successor !== undefined) {
        this.queuedSubscriptions.delete(subscription.stream)
        this.openSubscription(successor, subscription.stream)
      }
      return
    }
    if (!subscription.cancelling) this.publishStream(message)
  }

  private readonly handleChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.stopTreeMonitor()
    this.abortNativeActions()
    for (const listener of [...this.exitListeners]) {
      try {
        listener(code, signal)
      } catch (error) {
        console.error('[desktop-supervisor] exit listener threw:', error)
      }
    }
    const error = new Error(`desktop DSH child exited before shutdown completed (code ${String(code)}, signal ${String(signal)})`)
    if (this.stopping === undefined) this.rejectReady(error)
    this.failPending(error)
    this.closeStreams(this.stopping === undefined ? error : undefined)
  }

  private readonly onError = (error: Error): void => {
    this.abortNativeActions()
    this.rejectReady(error)
    this.failPending(error)
    this.closeStreams(error)
    this.failClosed()
  }

  private readonly onDisconnect = (): void => {
    this.abortNativeActions()
    const error = new Error('desktop DSH child IPC channel disconnected')
    this.rejectReady(error)
    this.failPending(error)
    this.closeStreams(error)
    this.failClosed()
  }

  private onSendError(message: DesktopParentMessage, error: Error): void {
    console.error('[desktop-supervisor] child IPC send callback failed:', error)
    if (message.type === 'request') {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      pending.reject(new Error(`desktop DSH child IPC send failed: ${error.message}`))
      return
    }
    if (message.type === 'subscribe') {
      const subscription = this.subscriptions.get(message.id)
      if (subscription !== undefined) {
        if (subscription.cancelling) this.failClosed()
        else this.rejectSubscription(message.id, `desktop DSH child IPC send failed: ${error.message}`)
      }
      return
    }
    if (message.type === 'cancel-subscription') {
      if (this.subscriptions.has(message.id)) {
        this.subscriptions.delete(message.id)
        this.terminateRendererStream(message.id, `desktop DSH child IPC send failed: ${error.message}`)
      }
      this.failClosed()
      return
    }
    if (message.type === 'native-response') {
      this.failClosed()
      return
    }
    this.failClosed()
  }

  private handleNativeRequest(message: Extract<DesktopChildMessage, { type: 'native-request' }>): void {
    const duplicate = this.nativeActions.get(message.id)
    if (duplicate !== undefined) {
      this.nativeActions.delete(message.id)
      duplicate.abort()
      this.respondNative(message.id, {
        ok: false,
        error: { code: 'invalid-request', message: `duplicate desktop native request id ${message.id}` },
      })
      return
    }
    const handler = this.nativeActionHandler
    if (handler === undefined) {
      this.respondNative(message.id, {
        ok: false,
        error: { code: 'unavailable', message: 'desktop native actions are unavailable' },
      })
      return
    }
    const controller = new AbortController()
    this.nativeActions.set(message.id, controller)
    void handler(message.request, controller.signal).then(
      (result) => {
        if (this.nativeActions.get(message.id) !== controller) return
        this.nativeActions.delete(message.id)
        this.respondNative(message.id, result)
      },
      (error: unknown) => {
        if (this.nativeActions.get(message.id) !== controller) return
        this.nativeActions.delete(message.id)
        this.respondNative(message.id, controller.signal.aborted
          ? { ok: false, error: { code: 'cancelled', message: 'desktop native action was cancelled' } }
          : {
            ok: false,
            error: { code: 'failed', message: error instanceof Error ? error.message : String(error) },
          })
      },
    )
  }

  private respondNative(id: string, result: DesktopNativeResult): void {
    const sent = this.send({ type: 'native-response', id, result })
    if (sent.kind === 'closed' || sent.kind === 'failed') this.failClosed()
  }

  private abortNativeActions(): void {
    const controllers = [...this.nativeActions.values()]
    this.nativeActions.clear()
    for (const controller of controllers) controller.abort()
  }

  private publishStream(message: StreamMessage): void {
    for (const listener of [...this.streamListeners]) {
      try {
        listener(message)
      } catch (error) {
        console.error('[desktop-supervisor] stream listener threw:', error)
      }
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private closeStreams(error?: Error): void {
    const subscriptions = [...this.subscriptions.entries()]
    const queued = [...this.queuedSubscriptions.values()]
    this.subscriptions.clear()
    this.queuedSubscriptions.clear()
    for (const [id, state] of subscriptions) {
      if (state.cancelling) continue
      if (error === undefined) this.publishStream({ type: 'stream-end', id })
      else this.terminateRendererStream(id, error.message)
    }
    for (const id of queued) {
      if (error === undefined) this.publishStream({ type: 'stream-end', id })
      else this.terminateRendererStream(id, error.message)
    }
  }

  private rejectReady(error: Error): void {
    if (this.settledReady) return
    this.settledReady = true
    this.ready.reject(error)
  }

  private async stopOnce(): Promise<void> {
    // Close command admission before aborting work or signaling the child: a
    // late message during SIGTERM grace must not recreate an owned resource.
    this.child.off('message', this.onMessage)
    this.failPending(new Error('desktop DSH child is stopping'))
    this.closeStreams()
    this.abortNativeActions()
    // Quit can race startup: settle a pending ready wait so lifecycle.start()
    // observers never hang behind a child that stop() already owns.
    if (!this.settledReady) this.rejectReady(new Error('desktop DSH child did not become ready before shutdown'))
    try {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        // The child already exited (crash recovery, startup failure): use the
        // newest pre-exit snapshot, falling back to a post-exit group scan.
        await this.terminateTree(false, this.latestSnapshot ?? this.snapshotTreeNow())
        return
      }
      // Snapshot while the child still parents its descendants: a PTY session
      // leader or grandchild that later reparents into its own group stays in
      // this snapshot by pid identity. If IPC failure raced the exit (Node
      // reports disconnect before exit), fall back to the pre-exit snapshot.
      const freshSnapshot = this.snapshotTreeNow()
      const snapshot = freshSnapshot?.rootPresent === true
        ? freshSnapshot
        : this.latestSnapshot ?? freshSnapshot
      const exited = new Promise<void>((resolve) => { this.child.on('exit', () => { resolve() }) })
      this.child.kill('SIGTERM')
      if (await this.waitForExit(exited, this.shutdownTimeoutMs)) {
        // Graceful dispose worked: verify quiescence and sweep stragglers.
        await this.terminateTree(false, snapshot)
        return
      }
      this.escalated = true
      this.child.kill('SIGKILL')
      const settled = await this.waitForExit(exited, this.shutdownTimeoutMs)
      // After forced termination, stragglers only get SIGKILL — SIGTERM already
      // proved insufficient for this tree.
      await this.terminateTree(true, snapshot)
      if (!settled) {
        throw new Error(`desktop DSH child did not exit within ${String(this.shutdownTimeoutMs)}ms`)
      }
    } finally {
      this.detach()
    }
  }

  /** Resolve true when the child exits in time, false when the grace elapses. */
  private async waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => { resolve(false) }, timeoutMs)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  private startTreeMonitor(): void {
    if (this.tree === undefined || this.treeMonitor !== undefined) return
    this.refreshTreeSnapshot()
    this.treeMonitor = setInterval(() => { this.refreshTreeSnapshot() }, this.treeSnapshotMs)
  }

  private stopTreeMonitor(): void {
    if (this.treeMonitor === undefined) return
    clearInterval(this.treeMonitor)
    this.treeMonitor = undefined
  }

  /** Refresh the pre-exit ownership snapshot while the child still lives. */
  private refreshTreeSnapshot(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.stopTreeMonitor()
      return
    }
    const snapshot = this.snapshotTreeNow()
    if (snapshot !== undefined && snapshot.rootPresent) this.latestSnapshot = snapshot
  }

  private snapshotTreeNow(): ProcessTreeSnapshot | undefined {
    const tree = this.tree
    const rootPid = this.child.pid
    return tree === undefined || rootPid === undefined ? undefined : tree.snapshot(rootPid)
  }

  /**
   * Sweep the owned process tree until quiescent: signal the groups of every
   * surviving snapshot entry, once per escalation stage, then verify. Throws an
   * actionable error listing survivors instead of claiming completion while any
   * owned DSH, PTY, or descendant process remains identifiable.
   * @param killOnly - skip the SIGTERM stage (the tree already outlived grace).
   * @param snapshot - the ownership snapshot; callers take it before signaling
   * the child so descendants stay identifiable after the parent exits.
   */
  private async terminateTree(killOnly: boolean, snapshot: ProcessTreeSnapshot | undefined): Promise<void> {
    const tree = this.tree
    if (tree === undefined || snapshot === undefined) return
    const stages: ReadonlyArray<'SIGTERM' | 'SIGKILL'> = killOnly ? ['SIGKILL'] : ['SIGTERM', 'SIGKILL']
    for (const signal of stages) {
      const remaining = tree.survivors(snapshot)
      if (remaining.length === 0) break
      if (signal === 'SIGKILL') this.escalated = true
      tree.signalGroups(remaining, signal)
      const deadline = Date.now() + this.treeGraceMs
      while (tree.survivors(snapshot).length > 0 && Date.now() < deadline) {
        await new Promise(resolveWait => setTimeout(resolveWait, 25))
      }
    }
    const remaining = tree.survivors(snapshot)
    if (remaining.length === 0) return
    const description = remaining.map(entry => `pid ${String(entry.pid)} (${entry.command})`).join(', ')
    throw new Error(`desktop DSH shutdown left ${String(remaining.length)} surviving process(es): ${description}`)
  }

  private detach(): void {
    this.stopTreeMonitor()
    this.child.off('message', this.onMessage)
    this.child.off('exit', this.handleChildExit)
    this.child.off('error', this.onError)
    this.child.off('disconnect', this.onDisconnect)
    this.subscriptions.clear()
    this.queuedSubscriptions.clear()
    this.streamListeners.clear()
  }
}
