/** Electron-main ownership of one application-scoped DSH child. */

import type {
  DesktopChildMessage,
  DesktopParentMessage,
} from '@deepseek-ai/dsh-desktop-app'

type ReadyMessage = Extract<DesktopChildMessage, { type: 'ready' }>
type ResponseMessage = Extract<DesktopChildMessage, { type: 'response' }>
type RequestErrorMessage = Extract<DesktopChildMessage, { type: 'request-error' }>
type StreamMessage = Exclude<DesktopChildMessage, ReadyMessage | ResponseMessage | RequestErrorMessage>

/** Child-process surface used by the supervisor and its tests. */
export interface DshChild {
  readonly connected: boolean
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  send(message: DesktopParentMessage): boolean
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  off(event: 'message', listener: (message: unknown) => void): this
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  off(event: 'error', listener: (error: Error) => void): this
}

/** Configured supervisor deadlines. */
export interface SupervisorOptions {
  readonly startupTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
}

interface PendingRequest {
  resolve(message: ResponseMessage): void
  reject(error: Error): void
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000

function errorOf(message: RequestErrorMessage): Error {
  return new Error(`desktop DSH request ${message.id} failed: ${message.message}`)
}

/** Supervise one child from startup handshake through terminate-and-join. */
export class DshSupervisor {
  private readonly startupTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly ready = Promise.withResolvers<ReadyMessage>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly streamListeners = new Set<(message: StreamMessage) => void>()
  private stopping: Promise<void> | undefined
  private settledReady = false

  constructor(private readonly child: DshChild, options: SupervisorOptions = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    child.on('message', this.onMessage)
    child.on('exit', this.onExit)
    child.on('error', this.onError)
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
    this.pending.set(message.id, result)
    this.send(message)
    return result.promise
  }

  /** Forward cancellation for a renderer-owned unary call. */
  cancelRequest(id: string): void {
    this.send({ type: 'cancel-request', id })
  }

  /** Open one renderer-owned logical event stream. */
  subscribe(id: string, stream: 'mux' | 'host'): void {
    this.send({ type: 'subscribe', id, stream })
  }

  /** Close one renderer-owned logical event stream. */
  cancelSubscription(id: string): void {
    this.send({ type: 'cancel-subscription', id })
  }

  /** Observe stream lifecycle messages for forwarding to the renderer. */
  onStream(listener: (message: StreamMessage) => void): () => void {
    this.streamListeners.add(listener)
    return () => { this.streamListeners.delete(listener) }
  }

  /** Ask the child to dispose its Cordis tree, then wait for process exit. */
  stop(): Promise<void> {
    this.stopping ??= this.stopOnce()
    return this.stopping
  }

  private send(message: DesktopParentMessage): void {
    if (!this.child.connected) return
    this.child.send(message)
  }

  private readonly onMessage = (value: unknown): void => {
    const message = value as DesktopChildMessage
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
    for (const listener of this.streamListeners) listener(message)
  }

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    const error = new Error(`desktop DSH child exited before shutdown completed (code ${String(code)}, signal ${String(signal)})`)
    if (this.stopping === undefined) this.rejectReady(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private readonly onError = (error: Error): void => {
    this.rejectReady(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private rejectReady(error: Error): void {
    if (this.settledReady) return
    this.settledReady = true
    this.ready.reject(error)
  }

  private async stopOnce(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.detach()
      return
    }
    const exited = new Promise<void>((resolve) => { this.child.on('exit', () => { resolve() }) })
    this.child.kill('SIGTERM')
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        exited,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`desktop DSH child did not exit within ${String(this.shutdownTimeoutMs)}ms`))
          }, this.shutdownTimeoutMs)
        }),
      ])
    } catch (error) {
      this.child.kill('SIGKILL')
      await exited
      throw error
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      this.detach()
    }
  }

  private detach(): void {
    this.child.off('message', this.onMessage)
    this.child.off('exit', this.onExit)
    this.child.off('error', this.onError)
    this.streamListeners.clear()
  }
}
