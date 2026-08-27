/** Host-side pump that drives native desktop actions through the child IPC boundary. */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  parseDesktopCapabilityResponse,
  type DesktopCapabilityValue,
  type DesktopChildEndpoint,
} from '@dsh-desktop/connection'

/** Validated arguments for one native action request. */
export type NativeActionParams =
  | { readonly action: 'pick-directory' }
  | { readonly action: 'open-path'; readonly path: string }

/** Absolute-path bound shared with the connection wire parser. */
const NATIVE_ACTION_PATH_LIMIT = 4_096

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function validateAction(params: NativeActionParams): Record<string, unknown> {
  if (params.action === 'pick-directory') return { type: 'capability-request', action: 'pick-directory' }
  if (params.action === 'open-path') {
    const path = params.path
    if (typeof path !== 'string' || path.length === 0
      || new TextEncoder().encode(path).length > NATIVE_ACTION_PATH_LIMIT
      || path.includes('\0') || !isAbsolute(path)) {
      throw new Error(`desktop native actions: open-path needs an absolute filesystem path, received ${JSON.stringify(path ?? null)}`)
    }
    return { type: 'capability-request', action: 'open-path', path }
  }
  throw new Error(`desktop native actions: unknown action ${JSON.stringify((params as { action?: unknown }).action)}`)
}

interface PendingRequest {
  settle(value: DesktopCapabilityValue | undefined, error?: Error): void
}

/**
 * One validated request/response leg from the DSH child to the Electron
 * shell. The channel owns the correlation map and the endpoint listener;
 * every settlement removes its entry first, so a late or duplicated reply
 * can never revive a settled request.
 */
class NativeActionChannel {
  private readonly endpoint: DesktopChildEndpoint
  private readonly pending = new Map<string, PendingRequest>()
  private owners = 0
  private attached = false
  private disposed = false

  constructor(endpoint: DesktopChildEndpoint) {
    this.endpoint = endpoint
  }

  /** Claim one ownership share; the last release detaches the listener. */
  acquire(): () => void {
    if (this.disposed) throw new Error('desktop native actions channel is disposed')
    this.owners += 1
    this.attach()
    let released = false
    return () => {
      if (released) return
      released = true
      this.owners -= 1
      if (this.owners !== 0) return
      if (this.pending.size > 0) {
        this.rejectAll(new Error('desktop native actions provider disposed'))
      }
      this.detach()
    }
  }

  /**
   * Send one native action to the shell and await its single settlement.
   * @param params - the validated action the shell should perform.
   * @param signal - caller lifetime; abort drops the correlation and rejects.
   */
  async request(params: NativeActionParams, signal: AbortSignal): Promise<DesktopCapabilityValue> {
    if (this.disposed) throw new Error('desktop native actions channel is disposed')
    if (signal.aborted) throw errorFrom(signal.reason)
    const request = validateAction(params)
    const id = randomUUID()
    const settled = new Promise<DesktopCapabilityValue>((resolve, reject) => {
      const onAbort = (): void => {
        // Removing the entry first makes any later shell reply unmatched.
        this.pending.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(errorFrom(signal.reason))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        settle: (value, error) => {
          signal.removeEventListener('abort', onAbort)
          if (error === undefined) resolve(value as DesktopCapabilityValue)
          else reject(error)
        },
      })
    })
    this.attach()
    try {
      this.send(request, id)
    } catch (error) {
      this.settle(id, undefined, errorFrom(error))
    }
    return await settled
  }

  private send(request: Record<string, unknown>, id: string): void {
    const message = { ...request, id }
    const accepted = this.endpoint.send(message as never, (error) => {
      if (error === null) return
      this.settle(id, undefined, new Error(`desktop native actions send failed: ${error.message}`))
    })
    if (!accepted || !this.endpoint.connected) {
      throw new Error('desktop native actions: Electron IPC channel is closed')
    }
  }

  private settle(id: string, value: DesktopCapabilityValue | undefined, error?: Error): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    pending.settle(value, error)
  }

  private readonly onMessage = (value: unknown): void => {
    // The pipe carries connection traffic too; only capability messages are ours.
    const kind = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined
    if (kind !== 'capability-response' && kind !== 'capability-error') return
    const message = parseDesktopCapabilityResponse(value)
    if (message === undefined) {
      console.error('[desktop-native] dropped malformed capability response')
      if (typeof value === 'object' && value !== null
        && typeof (value as { id?: unknown }).id === 'string') {
        this.settle(
          (value as { id: string }).id,
          undefined,
          new Error('desktop native actions: malformed capability response'),
        )
      }
      return
    }
    if (message.type === 'capability-response') {
      this.settle(
        message.id,
        message.kind === 'opened' ? { kind: 'opened' } : { kind: 'path', path: message.path },
      )
      return
    }
    this.settle(message.id, undefined, new Error(message.message))
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.settle(undefined, error)
    }
  }

  private readonly onDisconnect = (): void => {
    this.rejectAll(new Error('desktop native actions: Electron IPC channel closed'))
  }

  private attach(): void {
    if (this.attached || this.disposed) return
    this.attached = true
    this.endpoint.on('message', this.onMessage)
    this.endpoint.on('disconnect', this.onDisconnect)
  }

  private detach(): void {
    if (!this.attached) return
    this.attached = false
    this.endpoint.off('message', this.onMessage)
    this.endpoint.off('disconnect', this.onDisconnect)
  }

  /** Reject every live caller and stop accepting further requests. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rejectAll(new Error('desktop native actions channel is disposed'))
    this.detach()
  }
}

/** Test seam standing in for the production forked child process channel. */
export const internals: { endpoint: DesktopChildEndpoint } = {
  endpoint: process as unknown as DesktopChildEndpoint,
}

const channels = new WeakMap<DesktopChildEndpoint, NativeActionChannel>()

/**
 * Return the one channel shared by every native provider row of this child.
 * @param endpoint - process channel; production defaults to `process`.
 */
export function createNativeActionChannel(
  endpoint: DesktopChildEndpoint = internals.endpoint,
): {
  acquire(): () => void
  request(params: NativeActionParams, signal: AbortSignal): Promise<DesktopCapabilityValue>
  dispose(): void
} {
  let channel = channels.get(endpoint)
  if (channel === undefined) {
    channel = new NativeActionChannel(endpoint)
    channels.set(endpoint, channel)
  }
  return channel
}
