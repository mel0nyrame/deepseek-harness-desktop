import { describe, expect, it } from 'vitest'
import {
  isDesktopAppUrl,
  parseRendererRequest,
  parseRendererSubscription,
  toRendererStreamEvent,
} from '../src/renderer-ipc.ts'

describe('desktop renderer IPC boundary', () => {
  it('admits only the exact privileged application origin', () => {
    expect(isDesktopAppUrl('dsh://app/index.html')).toBe(true)
    expect(isDesktopAppUrl('dsh://app/bundle/plugin.js?rev=one')).toBe(true)
    expect(isDesktopAppUrl('dsh://app.evil/index.html')).toBe(false)
    expect(isDesktopAppUrl('https://app/index.html')).toBe(false)
    expect(isDesktopAppUrl('not a URL')).toBe(false)
  })

  it('validates and tags renderer unary requests before child forwarding', () => {
    expect(parseRendererRequest({
      id: 'request-1',
      url: 'dsh://app/api/session.list',
      method: 'POST',
      headers: [['content-type', 'application/json']],
      body: '{}',
    })).toEqual({
      type: 'request',
      id: 'request-1',
      url: 'dsh://app/api/session.list',
      method: 'POST',
      headers: [['content-type', 'application/json']],
      body: '{}',
    })
    expect(parseRendererRequest({ id: '', url: 'dsh://app/api/session.list', method: 'POST', headers: [] }))
      .toBeUndefined()
    expect(parseRendererRequest({ id: 'request-1', url: 'https://evil.test/api', method: 'POST', headers: [] }))
      .toBeUndefined()
    expect(parseRendererRequest({ id: 'request-1', url: 'dsh://app/api/session.list', method: 'POST', headers: [['x']] }))
      .toBeUndefined()
  })

  it('validates subscription commands and maps child stream lifecycle names', () => {
    expect(parseRendererSubscription('stream-1', 'mux')).toEqual({ id: 'stream-1', stream: 'mux' })
    expect(parseRendererSubscription('', 'mux')).toBeUndefined()
    expect(parseRendererSubscription('stream-1', 'other')).toBeUndefined()
    expect(toRendererStreamEvent({ type: 'stream-open', id: 'stream-1' }))
      .toEqual({ type: 'open', id: 'stream-1' })
    expect(toRendererStreamEvent({ type: 'stream-message', id: 'stream-1', message: { seq: 1 } }))
      .toEqual({ type: 'message', id: 'stream-1', message: { seq: 1 } })
    expect(toRendererStreamEvent({ type: 'stream-error', id: 'stream-1', message: 'broken' }))
      .toEqual({ type: 'error', id: 'stream-1', message: 'broken' })
    expect(toRendererStreamEvent({ type: 'stream-end', id: 'stream-1' }))
      .toEqual({ type: 'end', id: 'stream-1' })
  })
})
