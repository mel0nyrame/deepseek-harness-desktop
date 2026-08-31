import { describe, expect, it } from 'vitest'
import type { DesktopParentMessage } from '../packages/connection/src/protocol.ts'
import {
  createDesktopUiProtocolHandler,
  type DesktopUiProtocolRuntime,
} from '../apps/desktop/src/ui-protocol.ts'

class UiRuntime implements DesktopUiProtocolRuntime {
  requestMessage: Extract<DesktopParentMessage, { type: 'request' }> | undefined

  async request(message: Extract<DesktopParentMessage, { type: 'request' }>) {
    this.requestMessage = message
    const request = JSON.parse(message.body ?? '') as { rpcId: string; method: string; payload: unknown }
    return {
      status: 200,
      headers: [['content-type', 'application/json']] as const,
      body: JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            status: 200,
            contentType: 'text/html; charset=utf-8',
            cacheControl: 'no-cache',
            body: Buffer.from('<html>official</html>').toString('base64'),
          },
        },
      }),
    }
  }

  cancelRequest(): void {}
}

describe('desktop UI protocol', () => {
  it('loads dsh://app assets through the Host UI RPC channel', async () => {
    const runtime = new UiRuntime()
    const handle = createDesktopUiProtocolHandler(runtime)

    const response = await handle(new Request('dsh://app/index.html'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    await expect(response.text()).resolves.toBe('<html>official</html>')
    expect(runtime.requestMessage).toMatchObject({
      type: 'request',
      url: 'dsh://app/ui/asset',
      method: 'POST',
    })
    expect(JSON.parse(runtime.requestMessage?.body ?? '')).toMatchObject({
      type: 'client-request',
      method: 'asset',
      payload: { path: '/index.html' },
    })
  })

  it('rejects non-product origins and unsupported methods before reaching the Host', async () => {
    const runtime = new UiRuntime()
    const handle = createDesktopUiProtocolHandler(runtime)

    await expect(handle(new Request('https://example.com/index.html'))).resolves.toMatchObject({ status: 403 })
    await expect(handle(new Request('dsh://app/index.html', { method: 'POST' }))).resolves.toMatchObject({ status: 405 })
    expect(runtime.requestMessage).toBeUndefined()
  })

  it('returns no body for HEAD and rejects malformed Host envelopes', async () => {
    const runtime = new UiRuntime()
    const handle = createDesktopUiProtocolHandler(runtime)

    const head = await handle(new Request('dsh://app/assets/app.js', { method: 'HEAD' }))
    expect(head.status).toBe(200)
    await expect(head.text()).resolves.toBe('')

    const malformed = createDesktopUiProtocolHandler({
      request: async () => ({ status: 200, headers: [], body: '{}' }),
      cancelRequest() {},
    })
    await expect(malformed(new Request('dsh://app/index.html')))
      .resolves.toMatchObject({ status: 502 })

    const oversized = createDesktopUiProtocolHandler({
      request: async (message) => {
        const request = JSON.parse(message.body ?? '') as { rpcId: string }
        return {
          status: 200,
          headers: [],
          body: JSON.stringify({
            type: 'server-response',
            rpcId: request.rpcId,
            result: {
              ok: true,
              value: {
                status: 200,
                contentType: 'text/javascript',
                cacheControl: 'no-cache',
                body: 'A'.repeat(2 * 1024 * 1024 + 4),
              },
            },
          }),
        }
      },
      cancelRequest() {},
    })
    await expect(oversized(new Request('dsh://app/index.html')))
      .resolves.toMatchObject({ status: 502 })
  })

  it('cancels the Host request when navigation aborts', async () => {
    let rejectRequest: ((error: Error) => void) | undefined
    let cancelled = ''
    const handle = createDesktopUiProtocolHandler({
      request: async () => await new Promise((_resolve, reject) => { rejectRequest = reject }),
      cancelRequest(id) {
        cancelled = id
        rejectRequest?.(new Error('cancelled'))
      },
    })
    const controller = new AbortController()
    const response = handle(new Request('dsh://app/index.html', { signal: controller.signal }))

    controller.abort()

    await expect(response).resolves.toMatchObject({ status: 499 })
    expect(cancelled).not.toBe('')
  })
})
