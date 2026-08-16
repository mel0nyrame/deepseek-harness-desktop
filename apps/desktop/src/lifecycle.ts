/**
 * Application-scoped lifecycle owner for the bundled DSH Host. One instance
 * owns every path — normal quit, quit during startup, startup failure, and
 * crash recovery — so exactly one terminate-and-join ladder runs and no path
 * can claim completion while the owned process tree is still observable.
 * Electron-free by design: main.ts wires phases to the window, while unit
 * tests drive the machine over fake spawns.
 */

import type { DshSupervisor } from './supervisor.ts'

/** Ready handshake of a running generation (renderer boot payload). */
export type ReadyMessage = Awaited<ReturnType<DshSupervisor['start']>>

/** One user-visible application phase of the supervised Host. */
export type HostPhase = 'starting' | 'running' | 'recovering' | 'failed' | 'stopping' | 'stopped'

/** Failure classification reported to the user and tests. */
export type HostFailureKind = 'startup-timeout' | 'startup-failed' | 'unexpected-exit' | 'cleanup-incomplete'

/** An actionable Host failure: what happened, why, and what survived. */
export interface HostFailure {
  readonly kind: HostFailureKind
  readonly message: string
  /** Child exit/stderr context shown on the failure surface. */
  readonly detail?: string
  /** Processes the shutdown ladder could not terminate. */
  readonly survivors?: ReadonlyArray<{ readonly pid: number; readonly command: string }>
}

/** One spawned Host generation, produced by the injectable spawn factory. */
export interface LifecycleSpawn {
  readonly supervisor: DshSupervisor
  readonly childPid: number | undefined
  /** Recent child stderr lines, for actionable failure reporting. */
  tail(): string
}

export interface LifecycleOptions {
  /** Spawn one fresh Host generation (process + supervisor). */
  readonly spawn: () => LifecycleSpawn
}

/** Settlement of the single lifecycle-owned shutdown. */
export interface StopReport {
  /** The owned DSH tree reached quiescence; false means cleanup was incomplete. */
  readonly quiescent: boolean
  /** Shutdown escalated past graceful SIGTERM (forced escalation or sweep). */
  readonly escalated: boolean
  /** Actionable cleanup failure; success is never reported when present. */
  readonly failure?: HostFailure
}

interface Generation extends LifecycleSpawn {
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  readonly stopWatching: () => void
  /** Whether this generation completed its ready handshake. */
  ready: boolean
}

const STARTUP_TIMEOUT_PATTERN = /did not become ready within/

export class DesktopLifecycle {
  private phaseValue: HostPhase = 'stopped'
  private failureValue: HostFailure | undefined
  private generation: Generation | undefined
  private restartsRemaining = 1
  private starting: Promise<void> | undefined
  private stopping: Promise<StopReport> | undefined
  private readyMessage: ReadyMessage | undefined
  private quitRequested = false
  private restartBlocked = false
  private readonly phaseListeners = new Set<(phase: HostPhase) => void>()
  private readonly failureListeners = new Set<(failure: HostFailure) => void>()

  constructor(private readonly options: LifecycleOptions) {}

  /** Current user-visible phase. */
  get phase(): HostPhase {
    return this.phaseValue
  }

  /** The most recent failure, for the failure surface. */
  get failure(): HostFailure | undefined {
    return this.failureValue
  }

  /** The ready handshake of the running generation, for the renderer boot. */
  get bootInfo(): ReadyMessage | undefined {
    return this.readyMessage
  }

  /** The current generation's supervisor, when one exists. */
  current(): LifecycleSpawn | undefined {
    return this.generation
  }

  /** Boot the first generation; resolves when running, rejects when failed. */
  start(): Promise<void> {
    this.starting ??= this.runGeneration(false)
    return this.starting
  }

  /** Manual recovery from the failed state: boot a fresh generation. */
  async restart(): Promise<void> {
    if (this.phase !== 'failed') {
      throw new Error(`desktop lifecycle: restart is only available from the failed state, not ${this.phaseValue}`)
    }
    if (this.restartBlocked) {
      throw new Error('desktop lifecycle: restart is unavailable after an incomplete cleanup')
    }
    this.starting = undefined
    await this.runGeneration(false)
  }

  /** Whether the failed status page may offer its Restart action. */
  get restartAvailable(): boolean {
    return this.phaseValue === 'failed' && !this.restartBlocked
  }

  /**
   * The single lifecycle shutdown owner. Coalesced, and wins every race: a
   * ready handshake or failure that lands after stop() began cannot restart
   * or re-enter a running phase.
   */
  stop(): Promise<StopReport> {
    this.stopping ??= this.stopOnce()
    return this.stopping
  }

  /** Subscribe to phase transitions; returns the unsubscribe function. */
  onPhase(listener: (phase: HostPhase) => void): () => void {
    this.phaseListeners.add(listener)
    return () => { this.phaseListeners.delete(listener) }
  }

  /** Subscribe to failure reports; returns the unsubscribe function. */
  onFailure(listener: (failure: HostFailure) => void): () => void {
    this.failureListeners.add(listener)
    return () => { this.failureListeners.delete(listener) }
  }

  private setPhase(phase: HostPhase): void {
    if (this.phaseValue === phase) return
    this.phaseValue = phase
    for (const listener of [...this.phaseListeners]) {
      try {
        listener(phase)
      } catch (error) {
        console.error('[desktop-lifecycle] phase listener threw:', error)
      }
    }
  }

  private setFailure(failure: HostFailure): void {
    this.failureValue = failure
    for (const listener of [...this.failureListeners]) {
      try {
        listener(failure)
      } catch (error) {
        console.error('[desktop-lifecycle] failure listener threw:', error)
      }
    }
  }

  private spawnGeneration(): Generation {
    const spawn = this.options.spawn()
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => { this.onChildExit(code, signal) }
    const stopWatching = spawn.supervisor.onExit(onExit)
    return { ...spawn, onExit, stopWatching, ready: false }
  }

  private quitWasRequested(): boolean {
    return this.quitRequested
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.quitWasRequested()) return
    const detail = `Host process exited with code ${String(code)} and signal ${String(signal)}`
    const generation = this.generation
    if (generation === undefined || !generation.ready) {
      // The generation died before its ready handshake. When the failure was
      // already reported through another channel (IPC disconnect, startup
      // timeout), this late exit must not be misread as an unexpected exit of
      // a running Host and trigger a restart.
      if (this.phase === 'starting' || this.phase === 'recovering') {
        this.enterFailed({
          kind: 'startup-failed',
          message: `The bundled DSH runtime failed to start: ${detail}`,
          detail: this.tailDetail(detail),
        })
      }
      return
    }
    // Unexpected exit of a running Host: sweep the crashed generation's tree
    // before booting its replacement, so a later quit cannot forget survivors
    // that outlived the process that owned them.
    if (this.restartsRemaining > 0) {
      this.restartsRemaining -= 1
      this.setPhase('recovering')
      void this.recoverAfterExit(generation, detail).catch((error: unknown) => {
        this.enterFailed({
          kind: 'unexpected-exit',
          message: `The bundled DSH runtime stopped unexpectedly and the controlled restart failed: ${String(error)}`,
          detail: this.tailDetail(detail),
        })
      })
      return
    }
    this.enterFailed({
      kind: 'unexpected-exit',
      message: `The bundled DSH runtime stopped unexpectedly: ${detail}`,
      detail: this.tailDetail(detail),
    })
  }

  private async recoverAfterExit(generation: Generation, detail: string): Promise<void> {
    generation.stopWatching()
    try {
      // The child has already exited; stop() still owns the process tree it
      // left behind, and rejects when that tree cannot be made quiescent.
      await generation.supervisor.stop()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const survivors = parseSurvivors(message)
      this.enterFailed({
        kind: 'cleanup-incomplete',
        message: `The bundled DSH runtime stopped unexpectedly and its process tree could not be cleaned up: ${message}`,
        detail: this.tailDetail(detail),
        ...(survivors === undefined ? {} : { survivors }),
      })
      return
    }
    await this.runGeneration(true)
  }

  private tailDetail(prefix: string): string {
    const tail = this.generation?.tail().trim()
    return tail === undefined || tail === '' ? prefix : `${prefix}\n${tail}`
  }

  private async runGeneration(automatic: boolean): Promise<void> {
    if (this.quitWasRequested()) return
    const generation = this.spawnGeneration()
    this.generation = generation
    this.readyMessage = undefined
    // Phase listeners observe the generation this phase belongs to.
    this.setPhase(automatic ? 'recovering' : 'starting')
    try {
      const ready = await generation.supervisor.start()
      if (this.quitWasRequested()) {
        // Quit raced this generation's readiness: stop() already owns the
        // child and its tree; do not enter a running phase.
        return
      }
      this.readyMessage = ready
      this.failureValue = undefined
      generation.ready = true
      this.setPhase('running')
    } catch (error: unknown) {
      if (this.quitWasRequested()) return
      const message = error instanceof Error ? error.message : String(error)
      const kind = STARTUP_TIMEOUT_PATTERN.test(message) ? 'startup-timeout' : 'startup-failed'
      this.enterFailed({
        kind,
        message: kind === 'startup-timeout'
          ? `The bundled DSH runtime did not become ready in time: ${message}`
          : `The bundled DSH runtime failed to start: ${message}`,
        detail: this.tailDetail(message),
      })
      // The generation may still be alive but unusable: shut its tree down.
      await generation.supervisor.stop().catch((stopError: unknown) => {
        console.error(`[desktop-lifecycle] failed-start cleanup also failed: ${String(stopError)}`)
      })
    }
  }

  private enterFailed(failure: HostFailure): void {
    this.restartBlocked = failure.kind === 'cleanup-incomplete'
    this.setFailure(failure)
    this.setPhase('failed')
    const generation = this.generation
    if (generation === undefined) return
    void generation.supervisor.stop().catch((error: unknown) => {
      // A failed generation whose tree also cannot be cleaned up must not
      // offer Restart: a fresh generation would let quit forget the old tree.
      const message = error instanceof Error ? error.message : String(error)
      const survivors = parseSurvivors(message)
      const detail = `${failure.detail ?? ''}\nThe DSH runtime also could not be shut down cleanly: ${message}`.trim()
      this.restartBlocked = true
      this.setFailure({
        kind: failure.kind,
        message: failure.message,
        ...(detail === '' ? {} : { detail }),
        ...(survivors === undefined ? {} : { survivors }),
      })
    })
  }

  private async stopOnce(): Promise<StopReport> {
    this.quitRequested = true
    this.setPhase('stopping')
    const generation = this.generation
    let failure: HostFailure | undefined
    let escalated = false
    if (generation !== undefined) {
      generation.stopWatching()
      try {
        await generation.supervisor.stop()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const survivors = parseSurvivors(message)
        failure = {
          kind: 'cleanup-incomplete',
          message: `The DSH runtime did not shut down cleanly: ${message}`,
          ...(survivors === undefined ? {} : { survivors }),
        }
      }
      escalated = generation.supervisor.wasEscalated
    }
    if (failure !== undefined) this.setFailure(failure)
    else this.failureValue = undefined
    this.setPhase('stopped')
    return { quiescent: failure === undefined, escalated, ...(failure === undefined ? {} : { failure }) }
  }
}

function parseSurvivors(message: string): Array<{ pid: number; command: string }> | undefined {
  const match = /surviving process\(es\): (.+)$/.exec(message)
  const detail = match?.[1]
  if (detail === undefined) return undefined
  return detail.split(', ').flatMap((part) => {
    const entry = /^pid (\d+) \((.*)\)$/.exec(part)
    const pid = entry?.[1]
    const command = entry?.[2]
    return pid === undefined || command === undefined ? [] : [{ pid: Number(pid), command }]
  })
}
