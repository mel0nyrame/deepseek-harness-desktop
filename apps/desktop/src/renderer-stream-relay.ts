import type { RendererStreamEvent } from './renderer-ipc.ts'

/** Maximum renderer notifications retained by the Electron main relay. */
export const RENDERER_STREAM_QUEUE_LIMIT = 256

interface RendererStreamState {
  readonly queue: RendererStreamEvent[]
  inFlight: number
  terminal: 'error' | 'end' | undefined
  cancelling: boolean
}

/**
 * Bounded, acknowledged forwarding between the supervisor and one renderer.
 * The relay owns only transport state; the supervisor remains the owner of the
 * child subscription and receives cancellation through the callback.
 */
export class RendererStreamRelay {
  private readonly streams = new Map<string, RendererStreamState>()

  constructor(
    private readonly send: (event: RendererStreamEvent) => boolean,
    private readonly cancel: (id: string) => void,
    private readonly inFlightLimit = 32,
    private readonly queueLimit = RENDERER_STREAM_QUEUE_LIMIT,
  ) {}

  /** Queue one validated notification from the supervisor. */
  push(event: RendererStreamEvent): void {
    let state = this.streams.get(event.id)
    const opened = state === undefined && event.type === 'open'
    if (state === undefined) {
      state = { queue: [], inFlight: 0, terminal: undefined, cancelling: false }
      this.streams.set(event.id, state)
      if (event.type === 'message') {
        this.terminate(event.id, state, 'desktop renderer stream received a message before open')
        return
      }
    }
    if (state.terminal === 'end') return
    if (state.terminal === 'error' && event.type !== 'end') return
    if (state.terminal === 'error' && event.type === 'end') {
      state.terminal = 'end'
      state.queue.push(event)
      this.pump(event.id, state)
      return
    }
    if (event.type === 'open' && !opened) {
      this.terminate(event.id, state, 'desktop renderer stream received a duplicate open notification')
      return
    }
    if (event.type === 'message' && state.queue.length + state.inFlight >= this.queueLimit) {
      this.terminate(
        event.id,
        state,
        `desktop renderer stream queue limit of ${String(this.queueLimit)} frames exceeded`,
      )
      return
    } else {
      state.queue.push(event)
      if (event.type === 'end' || event.type === 'error') state.terminal = event.type
    }
    this.pump(event.id, state)
  }

  /** Release one renderer-side in-flight notification. */
  ack(id: string): void {
    const state = this.streams.get(id)
    if (state === undefined || state.inFlight === 0) return
    state.inFlight -= 1
    this.pump(id, state)
  }

  /** Drop one renderer generation's stream state after cancellation. */
  clear(id: string): void {
    this.streams.delete(id)
  }

  /** Drop all renderer state without issuing child cancellations. */
  clearAll(): void {
    this.streams.clear()
  }

  private terminate(id: string, state: RendererStreamState, message: string): void {
    state.queue.length = 0
    state.terminal = 'end'
    if (!state.cancelling) {
      state.cancelling = true
      this.cancel(id)
    }
    state.queue.push(
      { type: 'error', id, message },
      { type: 'end', id },
    )
    this.pump(id, state)
  }

  private pump(id: string, state: RendererStreamState): void {
    while (state.inFlight < this.inFlightLimit && state.queue.length > 0) {
      const event = state.queue.shift() as RendererStreamEvent
      if (!this.send(event)) {
        state.queue.length = 0
        this.streams.delete(id)
        if (!state.cancelling) {
          state.cancelling = true
          this.cancel(id)
        }
        return
      }
      state.inFlight += 1
    }
    if (state.terminal && state.queue.length === 0 && state.inFlight === 0) {
      this.streams.delete(id)
    }
  }
}
