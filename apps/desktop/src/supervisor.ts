import { fork, type ChildProcess } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import {
  parseDesktopChildMessage,
  type DesktopCapabilityValue,
  type DesktopChildMessage,
  type DesktopParentMessage,
} from '@dsh-desktop/connection'
import type {
  DesktopBridgeResponse,
  DesktopStream,
} from '@dsh-desktop/connection/carrier'

/** One Host-initiated native action awaiting the desktop shell's settlement. */
export type DesktopNativeAction = Extract<DesktopChildMessage, { type: 'capability-request' }>

/** Electron-main operating-system adapter for Host-initiated native actions. */
export type DesktopNativeActionHandler = (request: DesktopNativeAction, signal: AbortSignal) => Promise<DesktopCapabilityValue>
import {
  createProcessTreeLadder,
  type ProcessTreeLadder,
  type ProcessTreeSnapshot,
} from './process-tree.js'

/** Process surface owned by the desktop runtime supervisor. */
export interface DshChild {
  readonly pid: number | undefined
  readonly connected: boolean
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  send(message: unknown, callback?: (error: Error | null) => void): boolean
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  off(event: 'message', listener: (message: unknown) => void): this
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  off(event: 'error', listener: (error: Error) => void): this
}

/** Filesystem and process inputs for one embedded DSH generation. */
export interface DshSpawnOptions {
  readonly executable: string
  readonly cliEntry: string
  readonly runtimeRoot: string
  readonly home: string
}

/** Successful embedded runtime readiness. */
export interface DshReady {
  readonly profile: 'desktop'
  readonly pid: number
  readonly home: string
}

/** An exit not initiated by supervisor shutdown or restart. */
export interface UnexpectedDshExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** Spawn boundary injected by tests and backed by Electron's executable in production. */
export type SpawnDshChild = (options: DshSpawnOptions) => DshChild

export interface SupervisorOptions {
  readonly startupTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly tree?: ProcessTreeLadder
  readonly treeGraceMs?: number
  readonly treeSnapshotMs?: number
  readonly onProcessSnapshot?: (snapshot: ProcessTreeSnapshot) => void
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000
const DEFAULT_TREE_GRACE_MS = 1_000
const DEFAULT_TREE_SNAPSHOT_MS = 250

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readyHome(body: string, rpcId: string): string | undefined {
  let envelope: unknown
  try {
    envelope = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || !isRecord(envelope.result) || envelope.result.ok !== true || !isRecord(envelope.result.value)) return undefined
  const value = envelope.result.value
  return typeof value.version === 'string' && typeof value.cwd === 'string'
    && typeof value.attachedSessions === 'number' && Number.isSafeInteger(value.attachedSessions)
    && value.attachedSessions >= 0 && typeof value.home === 'string'
    && typeof value.canOpenPath === 'boolean'
    ? value.home
    : undefined
}

function validatePath(name: keyof DshSpawnOptions, value: string): void {
  if (value !== '' && isAbsolute(value)) return
  const label = name === 'cliEntry' ? 'CLI entry' : name === 'runtimeRoot' ? 'runtime root' : name
  throw new Error(`desktop DSH child ${label} must be an absolute path`)
}

function validateOptions(options: DshSpawnOptions): void {
  validatePath('executable', options.executable)
  validatePath('cliEntry', options.cliEntry)
  validatePath('runtimeRoot', options.runtimeRoot)
  validatePath('home', options.home)
}

function mergeSnapshots(
  previous: ProcessTreeSnapshot | undefined,
  current: ProcessTreeSnapshot,
): ProcessTreeSnapshot {
  if (previous === undefined || previous.rootPid !== current.rootPid) return current
  const owned = new Map<string, (typeof current.owned)[number]>()
  for (const entry of previous.owned) owned.set(`${String(entry.pid)}\0${entry.started}`, entry)
  for (const entry of current.owned) owned.set(`${String(entry.pid)}\0${entry.started}`, entry)
  return {
    rootPid: current.rootPid,
    rootPresent: current.rootPresent,
    ...((current.root ?? previous.root) === undefined ? {} : { root: current.root ?? previous.root }),
    owned: [...owned.values()],
  }
}

/** Spawn the embedded runtime under Electron's Node-compatible execution mode. */
export function spawnDshChild(options: DshSpawnOptions): DshChild {
  const ptyHelper = join(
    options.runtimeRoot,
    'node_modules',
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  )
  const child = fork(options.cliEntry, ['--profile', 'desktop'], {
    cwd: options.home,
    execPath: options.executable,
    execArgv: ['--expose-internals'],
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      DSH_HOME: options.home,
      DSH_TELEMETRY_DISABLED: '1',
      ELECTRON_RUN_AS_NODE: '1',
      ...(process.platform === 'darwin' ? { DSH_NODE_PTY_SPAWN_HELPER: ptyHelper } : {}),
    },
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(chunk) })
  child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(chunk) })
  return child as ChildProcess as DshChild
}

/** Own one embedded DSH generation at a time from spawn through joined exit. */
export class DshSupervisor {
  private readonly spawnChild: SpawnDshChild
  private readonly startupTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly tree: ProcessTreeLadder | undefined
  private readonly treeGraceMs: number
  private readonly treeSnapshotMs: number
  private readonly onProcessSnapshot: ((snapshot: ProcessTreeSnapshot) => void) | undefined
  private child: DshChild | undefined
  private launchOptions: DshSpawnOptions | undefined
  private stopping: Promise<void> | undefined
  private startupFailure: Error | undefined
  private snapshot: ProcessTreeSnapshot | undefined
  private snapshotTimer: ReturnType<typeof setInterval> | undefined
  private ready = false
  private readonly unexpectedExits: UnexpectedDshExit[] = []
  private readonly unexpectedExitWaiters: Array<(exit: UnexpectedDshExit) => void> = []
  private readonly pending = new Map<string, Deferred<DesktopBridgeResponse>>()
  private readonly subscriptions = new Map<string, DesktopStream>()
  private readonly streamListeners = new Set<(message: DesktopChildMessage) => void>()
  private readonly activeNativeActions = new Map<string, {
    readonly owner: DshChild
    readonly handler: DesktopNativeActionHandler
    readonly controller: AbortController
    readonly done: Promise<void>
    readonly resolveDone: () => void
  }>()
  private resourceFailure: Promise<void> | undefined
  private nativeActionHandler: DesktopNativeActionHandler | undefined

  constructor(
    spawnChild: SpawnDshChild = spawnDshChild,
    options: SupervisorOptions = {},
  ) {
    this.spawnChild = spawnChild
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.tree = options.tree ?? createProcessTreeLadder()
    this.treeGraceMs = options.treeGraceMs ?? DEFAULT_TREE_GRACE_MS
    this.treeSnapshotMs = options.treeSnapshotMs ?? DEFAULT_TREE_SNAPSHOT_MS
    this.onProcessSnapshot = options.onProcessSnapshot
  }

  /** Validate, spawn, and wait until the `desktop` profile is active. */
  async start(options: DshSpawnOptions): Promise<DshReady> {
    validateOptions(options)
    if (this.child !== undefined) throw new Error('desktop DSH child is already running')
    this.launchOptions = options
    return await this.startGeneration(options)
  }

  /** Resolve with the next exit that was not initiated by stop or restart. */
  nextUnexpectedExit(): Promise<UnexpectedDshExit> {
    const queued = this.unexpectedExits.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise(resolve => { this.unexpectedExitWaiters.push(resolve) })
  }

  /** Send one unary carrier request and correlate the child response. */
  request(message: Extract<DesktopParentMessage, { type: 'request' }>): Promise<DesktopBridgeResponse> {
    if (this.pending.has(message.id)) return Promise.reject(new Error(`duplicate desktop request id ${message.id}`))
    const result = deferred<DesktopBridgeResponse>()
    this.pending.set(message.id, result)
    try {
      this.send(message)
    } catch (error) {
      this.pending.delete(message.id)
      result.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return result.promise
  }

  /** Cancel one renderer-owned unary request. */
  cancelRequest(id: string): void {
    const pending = this.pending.get(id)
    if (pending !== undefined) {
      this.pending.delete(id)
      pending.reject(new Error(`desktop DSH request ${id} cancelled`))
    }
    this.sendIfConnected({ type: 'cancel-request', id })
  }

  /** Open one renderer-owned logical Host stream. */
  subscribe(id: string, stream: DesktopStream): void {
    if (this.subscriptions.has(id)) throw new Error(`duplicate desktop subscription id ${id}`)
    this.subscriptions.set(id, stream)
    try {
      this.send({ type: 'subscribe', id, stream })
    } catch (error) {
      this.terminateSubscription(id, error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Forward one renderer acknowledgement to the Host child. */
  ackStream(id: string): void {
    if (this.subscriptions.has(id)) this.sendIfConnected({ type: 'stream-ack', id })
  }

  /** Close one renderer-owned logical Host stream. */
  cancelSubscription(id: string): void {
    if (!this.subscriptions.delete(id)) return
    this.sendIfConnected({ type: 'cancel-subscription', id })
  }

  /** Observe validated stream lifecycle messages. */
  onStream(listener: (message: DesktopChildMessage) => void): () => void {
    this.streamListeners.add(listener)
    return () => { this.streamListeners.delete(listener) }
  }

  /**
   * Install the operating-system adapter that settles Host-initiated native
   * actions; survives child restarts and is removed only by the disposer.
   */
  onNativeActions(handler: DesktopNativeActionHandler): () => void {
    this.nativeActionHandler = handler
    let disposed = false
    return () => {
      if (disposed || this.nativeActionHandler !== handler) return
      disposed = true
      this.nativeActionHandler = undefined
      for (const action of this.activeNativeActions.values()) {
        if (action.handler !== handler) continue
        action.controller.abort(new Error('desktop native action handler was removed'))
      }
    }
  }

  /** Stop and join the current generation, then start one replacement. */
  async restart(): Promise<DshReady> {
    const options = this.launchOptions
    if (options === undefined) throw new Error('desktop DSH child has not been configured')
    await this.stop()
    this.stopping = undefined
    return await this.startGeneration(options)
  }

  /** Terminate and join the current generation. Repeated calls share one join. */
  stop(): Promise<void> {
    this.stopping ??= this.stopGeneration()
    return this.stopping
  }

  private async startGeneration(options: DshSpawnOptions): Promise<DshReady> {
    const child = this.spawnChild(options)
    this.child = child
    this.ready = false
    this.startupFailure = undefined
    this.snapshot = undefined
    const result = deferred<DshReady>()
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const readinessId = 'desktop-readiness'
    const readinessRpcId = 'desktop-readiness-rpc'
    const cleanupStartup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout)
    }
    const settleFailure = (error: Error): void => {
      if (settled) return
      settled = true
      cleanupStartup()
      result.reject(error)
    }
    const onMessage = (message: unknown): void => { this.handleMessage(message) }
    const onError = (error: Error): void => {
      settleFailure(error)
      void this.failResources(error).catch(cleanupError => {
        console.error('[desktop-supervisor] resource cleanup failed:', cleanupError)
      })
      if (this.ready) void this.stop()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.off('exit', onExit)
      child.off('message', onMessage)
      child.off('error', onError)
      this.stopSnapshotMonitor()
      if (child.pid !== undefined) this.refreshSnapshot(child.pid)
      cleanupStartup()
      const controlled = this.stopping !== undefined
      if (this.child === child) this.child = undefined
      for (const action of this.activeNativeActions.values()) {
        if (action.owner === child) {
          action.controller.abort(new Error('desktop DSH child stopped'))
        }
      }
      const exitError = this.startupFailure ?? new Error(
        `desktop DSH child exited before readiness (code ${String(code)}, signal ${String(signal)})`,
      )
      const cleaned = controlled
        ? this.stopping as Promise<void>
        : this.terminateCurrentTree()
      const readiness = this.pending.get(readinessId)
      this.pending.delete(readinessId)
      if (!settled) {
        void cleaned.then(
          () => {
            readiness?.reject(exitError)
            settleFailure(exitError)
          },
          (cleanupError: unknown) => {
            const aggregate = new AggregateError(
              [exitError, cleanupError],
              `${exitError.message}; process-tree cleanup failed`,
            )
            readiness?.reject(aggregate)
            settleFailure(aggregate)
          },
        )
      }
      void this.failResources(new Error(
        `desktop DSH child exited (code ${String(code)}, signal ${String(signal)})`,
      )).catch(cleanupError => {
        console.error('[desktop-supervisor] resource cleanup failed:', cleanupError)
      })
      if (this.ready && !controlled) {
        void cleaned.then(
          () => { this.publishUnexpectedExit({ code, signal }) },
          error => {
            console.error('[desktop-supervisor] unexpected-exit cleanup failed:', error)
            this.publishUnexpectedExit({ code, signal })
          },
        )
      }
      this.ready = false
    }
    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
    if (child.pid !== undefined) this.startSnapshotMonitor(child.pid)
    void this.request({
      type: 'request',
      id: readinessId,
      url: 'dsh://app/api/host.describe',
      method: 'POST',
      headers: [['content-type', 'application/json']],
      body: JSON.stringify({
        type: 'client-request',
        rpcId: readinessRpcId,
        method: 'host.describe',
        payload: {},
      }),
    }).then((response) => {
      if (settled) return
      try {
        if (response.status !== 200) throw new Error(`host.describe returned HTTP ${String(response.status)}`)
        const home = readyHome(response.body, readinessRpcId)
        if (home === undefined) {
          throw new Error('host.describe returned an invalid Host description')
        }
        const pid = child.pid
        if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
          throw new Error('desktop DSH child became ready without a valid process id')
        }
        settled = true
        this.ready = true
        this.refreshSnapshot(pid)
        cleanupStartup()
        result.resolve({ profile: 'desktop', pid, home })
      } catch (error) {
        settleFailure(error instanceof Error ? error : new Error(String(error)))
      }
    }, settleFailure)
    timeout = setTimeout(() => {
      if (settled) return
      this.startupFailure = new Error(
        `desktop DSH child did not become ready within ${String(this.startupTimeoutMs)}ms`,
      )
      void this.stop().then(
        () => { settleFailure(this.startupFailure as Error) },
        error => { settleFailure(error instanceof Error ? error : new Error(String(error))) },
      )
    }, this.startupTimeoutMs)
    return await result.promise
  }

  private publishUnexpectedExit(exit: UnexpectedDshExit): void {
    const waiter = this.unexpectedExitWaiters.shift()
    if (waiter === undefined) this.unexpectedExits.push(exit)
    else waiter(exit)
  }

  private handleMessage(value: unknown): void {
    const message = parseDesktopChildMessage(value)
    if (message === undefined) {
      console.error('[desktop-supervisor] dropped malformed child IPC message')
      return
    }
    if (message.type === 'response' || message.type === 'request-error') {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.type === 'response') {
        pending.resolve({ status: message.status, headers: message.headers, body: message.body })
      } else {
        pending.reject(new Error(`desktop DSH request ${message.id} failed: ${message.message}`))
      }
      return
    }
    if (message.type === 'capability-request') {
      this.dispatchNativeAction(message)
      return
    }
    if (!this.subscriptions.has(message.id)) return
    if (message.type === 'stream-end') this.subscriptions.delete(message.id)
    this.notifyStream(message)
  }

  /** Settle one Host-initiated native action exactly once through the OS adapter. */
  private dispatchNativeAction(request: DesktopNativeAction): void {
    const owner = this.child
    if (owner === undefined || !owner.connected) return
    const reply = (message: Extract<DesktopParentMessage, { type: 'capability-response' | 'capability-error' }>): void => {
      try {
        if (!owner.connected) throw new Error('desktop DSH child IPC channel is closed')
        owner.send(message)
      } catch (error) {
        console.error('[desktop-supervisor] native action reply delivery failed:', error)
      }
    }
    if (this.activeNativeActions.has(request.id)) {
      reply({ type: 'capability-error', id: request.id, message: 'duplicate native action id' })
      return
    }
    const handler = this.nativeActionHandler
    if (handler === undefined) {
      reply({ type: 'capability-error', id: request.id, message: 'no desktop native action handler is installed' })
      return
    }
    const actionDone = deferred<void>()
    const action = {
      owner,
      handler,
      controller: new AbortController(),
      done: actionDone.promise,
      resolveDone: () => { actionDone.resolve() },
    }
    this.activeNativeActions.set(request.id, action)
    void (async () => {
      try {
        const value = await handler(request, action.controller.signal)
        reply({ type: 'capability-response', id: request.id, ...value })
      } catch (error) {
        reply({
          type: 'capability-error',
          id: request.id,
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        action.resolveDone()
        if (this.activeNativeActions.get(request.id) === action) {
          this.activeNativeActions.delete(request.id)
        }
      }
    })()
  }

  private send(message: DesktopParentMessage): void {
    const child = this.child
    if (child === undefined || !child.connected) throw new Error('desktop DSH child IPC channel is closed')
    const accepted = child.send(message, (error) => {
      if (error === null) return
      if (message.type === 'request') {
        const pending = this.pending.get(message.id)
        if (pending !== undefined) {
          this.pending.delete(message.id)
          pending.reject(new Error(`desktop DSH child IPC send failed: ${error.message}`))
        }
      } else if (message.type === 'subscribe') {
        this.terminateSubscription(
          message.id,
          new Error(`desktop DSH child IPC send failed: ${error.message}`),
        )
      }
    })
    if (!accepted && !child.connected) throw new Error('desktop DSH child IPC channel is closed')
  }

  private sendIfConnected(message: DesktopParentMessage): void {
    try {
      this.send(message)
    } catch (error) {
      console.error('[desktop-supervisor] child IPC send failed:', error)
    }
  }

  private async failResources(error: Error): Promise<void> {
    if (this.resourceFailure !== undefined) return await this.resourceFailure
    const cleanup = this.failResourcesNow(error)
    this.resourceFailure = cleanup
    try {
      await cleanup
    } finally {
      if (this.resourceFailure === cleanup) this.resourceFailure = undefined
    }
  }

  private async failResourcesNow(error: Error): Promise<void> {
    const nativeActions = [...this.activeNativeActions.values()]
    for (const [id, action] of this.activeNativeActions) {
      action.controller.abort(error)
      this.activeNativeActions.delete(id)
    }
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    const ids = [...this.subscriptions.keys()]
    this.subscriptions.clear()
    for (const id of ids) {
      this.notifyStream({ type: 'stream-error', id, message: error.message })
      this.notifyStream({ type: 'stream-end', id })
    }
    await this.waitForNativeActions(nativeActions)
  }

  private async waitForNativeActions(actions: readonly { readonly done: Promise<void> }[]): Promise<void> {
    if (actions.length === 0) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    const completed = await Promise.race([
      Promise.all(actions.map(action => action.done)).then(() => true),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => { resolve(false) }, this.shutdownTimeoutMs)
      }),
    ])
    if (timeout !== undefined) clearTimeout(timeout)
    if (!completed) throw new Error(
      `desktop native actions did not settle within ${String(this.shutdownTimeoutMs)}ms (${String(actions.length)} action${actions.length === 1 ? '' : 's'})`,
    )
  }

  private terminateSubscription(id: string, error: Error): void {
    if (!this.subscriptions.delete(id)) return
    this.notifyStream({ type: 'stream-error', id, message: error.message })
    this.notifyStream({ type: 'stream-end', id })
  }

  private notifyStream(message: DesktopChildMessage): void {
    for (const listener of new Set(this.streamListeners)) {
      try {
        listener(message)
      } catch (error) {
        console.error('[desktop-supervisor] stream listener threw:', error)
      }
    }
  }

  private startSnapshotMonitor(pid: number): void {
    this.stopSnapshotMonitor()
    if (this.tree === undefined) return
    this.refreshSnapshot(pid)
    this.snapshotTimer = setInterval(() => { this.refreshSnapshot(pid) }, this.treeSnapshotMs)
    this.snapshotTimer.unref?.()
  }

  private refreshSnapshot(pid: number): void {
    try {
      const current = this.tree?.snapshot(pid)
      if (current !== undefined) {
        this.snapshot = mergeSnapshots(this.snapshot, current)
        this.onProcessSnapshot?.(this.snapshot)
      }
    } catch (error) {
      console.error('[desktop-supervisor] process-tree snapshot failed:', error)
    }
  }

  private stopSnapshotMonitor(): void {
    if (this.snapshotTimer === undefined) return
    clearInterval(this.snapshotTimer)
    this.snapshotTimer = undefined
  }

  private async stopGeneration(): Promise<void> {
    this.stopSnapshotMonitor()
    const child = this.child
    if (child === undefined) {
      await this.terminateCurrentTree()
      await this.failResources(new Error('desktop DSH child stopped'))
      return
    }
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      this.refreshSnapshot(child.pid)
    }
    const exited = new Promise<void>((resolve) => {
      const onExit = (): void => {
        child.off('exit', onExit)
        resolve()
      }
      child.on('exit', onExit)
    })
    let rootExitError: Error | undefined
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      if (!await this.waitForExit(exited)) {
        child.kill('SIGKILL')
        if (!await this.waitForExit(exited)) {
          rootExitError = new Error(
            `desktop DSH child did not exit within ${String(this.shutdownTimeoutMs)}ms`,
          )
        }
      }
    }
    let treeError: Error | undefined
    try {
      await this.terminateCurrentTree()
    } catch (error) {
      treeError = error instanceof Error ? error : new Error(String(error))
    }
    await this.failResources(new Error('desktop DSH child stopped'))
    const errors = [rootExitError, treeError].filter((error): error is Error => error !== undefined)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'desktop DSH shutdown did not reach quiescence')
  }

  private async terminateCurrentTree(): Promise<void> {
    const snapshot = this.snapshot
    await this.terminateTree(snapshot)
    if (this.snapshot === snapshot) this.snapshot = undefined
  }

  private async waitForExit(exited: Promise<void>): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => { resolve(false) }, this.shutdownTimeoutMs)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  private async terminateTree(snapshot: ProcessTreeSnapshot | undefined): Promise<void> {
    if (snapshot === undefined || this.tree === undefined) return
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const remaining = this.tree.survivors(snapshot)
      if (remaining.length === 0) return
      this.tree.signalGroups(remaining, signal)
      const deadline = Date.now() + this.treeGraceMs
      while (this.tree.survivors(snapshot).length > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    const remaining = this.tree.survivors(snapshot)
    if (remaining.length === 0) return
    const detail = remaining.map(entry => `pid ${String(entry.pid)} (${entry.command})`).join(', ')
    throw new Error(`desktop DSH shutdown left ${String(remaining.length)} surviving process(es): ${detail}`)
  }
}
