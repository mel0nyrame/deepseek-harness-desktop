import { describe, expect, it } from 'vitest'
import { RendererStreamRelay } from '../src/renderer-stream-relay.ts'

describe('renderer stream relay', () => {
  it('preserves order while acknowledgements release the bounded window', () => {
    const sent: string[] = []
    const relay = new RendererStreamRelay(
      (event) => { sent.push(event.type === 'message' ? String(event.message) : event.type); return true },
      () => {},
      1,
      3,
    )

    relay.push({ type: 'open', id: 'stream-1' })
    relay.push({ type: 'message', id: 'stream-1', message: 'one' })
    relay.push({ type: 'message', id: 'stream-1', message: 'two' })
    expect(sent).toEqual(['open'])

    relay.ack('stream-1')
    expect(sent).toEqual(['open', 'one'])
    relay.ack('stream-1')
    expect(sent).toEqual(['open', 'one', 'two'])
  })

  it('cancels and closes a stream when its bounded queue overflows', () => {
    const sent: string[] = []
    const cancelled: string[] = []
    const relay = new RendererStreamRelay(
      (event) => { sent.push(event.type === 'message' ? String(event.message) : event.type); return true },
      (id) => { cancelled.push(id) },
      1,
      2,
    )

    relay.push({ type: 'open', id: 'stream-1' })
    relay.push({ type: 'message', id: 'stream-1', message: 'one' })
    relay.push({ type: 'message', id: 'stream-1', message: 'two' })

    expect(cancelled).toEqual(['stream-1'])
    relay.ack('stream-1')
    relay.ack('stream-1')
    relay.ack('stream-1')
    expect(sent).toEqual(['open', 'error', 'end'])
  })

  it('cancels and terminates a stream when a message arrives before open', () => {
    const sent: string[] = []
    const cancelled: string[] = []
    const relay = new RendererStreamRelay(
      (event) => { sent.push(event.type); return true },
      (id) => { cancelled.push(id) },
      1,
      2,
    )

    relay.push({ type: 'message', id: 'stream-1', message: 'early' })

    expect(cancelled).toEqual(['stream-1'])
    expect(sent).toEqual(['error'])
    relay.ack('stream-1')
    expect(sent).toEqual(['error', 'end'])
  })

  it('forwards a terminal rejection even when opening the child stream failed', () => {
    const sent: string[] = []
    const relay = new RendererStreamRelay(
      (event) => { sent.push(event.type); return true },
      () => {},
      1,
      2,
    )

    relay.push({ type: 'error', id: 'stream-1', message: 'closed' })
    relay.push({ type: 'end', id: 'stream-1' })

    expect(sent).toEqual(['error'])
    relay.ack('stream-1')
    expect(sent).toEqual(['error', 'end'])
  })

  it('cancels a stream after one duplicate open instead of retaining repeated lifecycle frames', () => {
    const sent: string[] = []
    const cancelled: string[] = []
    const relay = new RendererStreamRelay(
      (event) => { sent.push(event.type); return true },
      (id) => { cancelled.push(id) },
      1,
      2,
    )

    relay.push({ type: 'open', id: 'stream-1' })
    for (let index = 0; index < 10; index += 1) relay.push({ type: 'open', id: 'stream-1' })
    expect(cancelled).toEqual(['stream-1'])

    relay.ack('stream-1')
    relay.ack('stream-1')
    relay.ack('stream-1')
    expect(sent).toEqual(['open', 'error', 'end'])
  })
})
