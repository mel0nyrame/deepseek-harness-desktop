/**
 * Deterministic child-process double for supervisor and lifecycle unit tests.
 * Shared by every suite that drives {@link DshSupervisor} without a real
 * process; never imported by product code.
 */

import { EventEmitter } from 'node:events'
import type { DesktopChildMessage, DesktopParentMessage } from '@deepseek-ai/dsh-desktop-app'
import type { DshChild } from '../../src/supervisor.ts'

export class FakeChild extends EventEmitter implements DshChild {
  pid: number | undefined = undefined
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly sent: DesktopParentMessage[] = []
  readonly killed: NodeJS.Signals[] = []
  sendResult = true
  nextSendError: Error | undefined

  send(message: DesktopParentMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    const error = this.nextSendError
    this.nextSendError = undefined
    queueMicrotask(() => { callback?.(error ?? null) })
    return this.sendResult
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal)
    return true
  }

  receive(message: DesktopChildMessage): void {
    this.emit('message', message)
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.connected = false
    this.emit('exit', code, signal)
  }

  disconnect(): void {
    this.connected = false
    this.emit('disconnect')
  }
}
