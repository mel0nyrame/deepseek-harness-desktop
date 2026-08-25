import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '../packages/bundle/node_modules/@deepseek-ai/cordis/lib/types/index.d.ts'
import type { ConnectionHandle, ConnectionTransport } from '../packages/connection/src/carrier.js'
import type { DesktopChildEndpoint, DesktopChildMessage } from '../packages/connection/src/index.js'
import { createDesktopPreload, type ContextBridgeLike, type IpcRendererLike } from '../packages/connection/src/preload.js'

interface OfficialClientExports {
  createConnectionHandle(transport: ConnectionTransport): ConnectionHandle
  createFetchConnectionRpc(fetcher: typeof fetch): ConnectionTransport['rpc']
}

interface HostPluginExports {
  readonly internals: {
    endpoint: DesktopChildEndpoint
  }
}

const bundleRequire = createRequire(new URL('../packages/bundle/package.json', import.meta.url))
const bundleAnchor = new URL('../packages/bundle/package.json', import.meta.url).href
const hostPluginUrl = pathToFileURL(bundleRequire.resolve('@dsh-desktop/connection')).href
const clientPluginUrl = pathToFileURL(bundleRequire.resolve('@dsh-desktop/connection/client')).href
const { boot } = bundleRequire('@deepseek-ai/dsh-app-boot') as {
  boot(
    binName: string,
    absoluteConfigPath: string,
    patches: undefined,
    prepare: (ctx: Context) => Promise<void> | void,
    bareModuleBaseUrl: string,
  ): Promise<Context>
}

async function loadOfficialClientExports(): Promise<OfficialClientExports> {
  let exports: OfficialClientExports | undefined
  Object.assign(globalThis, {
    window: {
      __ModuleLoader__: {
        load(module: { factory(require: (id: string) => unknown): OfficialClientExports }) {
          exports = module.factory((id) => { throw new Error(`unexpected client dependency: ${id}`) })
          return exports
        },
      },
    },
  })
  const entry = new URL('../packages/connection/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js', import.meta.url)
  await import(`${entry.href}?connection-composition`)
  if (exports === undefined) throw new Error('official Client bundle did not register')
  return exports
}

class RelayEndpoint extends EventEmitter implements DesktopChildEndpoint {
  connected = true
  relay: ((message: DesktopChildMessage) => void) | undefined

  send(message: DesktopChildMessage, callback?: (error: Error | null) => void): boolean {
    this.relay?.(message)
    callback?.(null)
    return true
  }
}

class RelayIpc extends EventEmitter implements IpcRendererLike {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  private readonly endpoint: RelayEndpoint

  constructor(endpoint: RelayEndpoint) {
    super()
    this.endpoint = endpoint
    endpoint.relay = message => { this.fromHost(message) }
  }

  invoke(channel: string, value: unknown): Promise<unknown> {
    if (channel !== 'dsh:request' || typeof value !== 'object' || value === null || !('id' in value)
      || typeof value.id !== 'string') return Promise.reject(new Error('unexpected relay invocation'))
    const pending = new Promise<unknown>((resolve, reject) => {
      this.pending.set(value.id as string, { resolve, reject })
    })
    this.endpoint.emit('message', { type: 'request', ...value })
    return pending
  }

  send(channel: string, ...args: unknown[]): void {
    const id = args[0]
    if (typeof id !== 'string') throw new Error(`relay ${channel} requires an id`)
    if (channel === 'dsh:subscribe') this.endpoint.emit('message', { type: 'subscribe', id, stream: args[1] })
    else if (channel === 'dsh:cancel-request') this.endpoint.emit('message', { type: 'cancel-request', id })
    else if (channel === 'dsh:cancel-subscription') this.endpoint.emit('message', { type: 'cancel-subscription', id })
    else if (channel === 'dsh:stream-ack') this.endpoint.emit('message', { type: 'stream-ack', id })
    else throw new Error(`unexpected relay channel ${channel}`)
  }

  override on(channel: string, listener: (event: unknown, value: unknown) => void): this {
    return super.on(channel, listener)
  }

  override off(channel: string, listener: (event: unknown, value: unknown) => void): this {
    return super.off(channel, listener)
  }

  private fromHost(message: DesktopChildMessage): void {
    if (message.type === 'response' || message.type === 'request-error') {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.type === 'response') pending.resolve({
        status: message.status, headers: message.headers, body: message.body,
      })
      else pending.reject(new Error(message.message))
      return
    }
    const event = message.type === 'stream-open'
      ? { type: 'open', id: message.id }
      : message.type === 'stream-message'
        ? { type: 'message', id: message.id, message: message.message }
        : message.type === 'stream-error'
          ? { type: 'error', id: message.id, message: message.message }
          : { type: 'end', id: message.id }
    this.emit('dsh:stream', {}, event)
  }
}

async function *idleFrames(signal: AbortSignal): AsyncGenerator<never> {
  yield *([] as never[])
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

afterEach(() => {
  globalThis.dshDesktop = undefined
  vi.doUnmock('@deepseek-ai/dsh-client-connection/client')
})

it('boots real Client and Host connection plugins over IPC without WebServer or a listener', async () => {
  const official = await loadOfficialClientExports()
  const hostPlugin = await import(hostPluginUrl) as HostPluginExports
  const clientPlugin = await import(clientPluginUrl)
  clientPlugin.internals.createConnectionHandle = official.createConnectionHandle
  clientPlugin.internals.createFetchConnectionRpc = official.createFetchConnectionRpc
  const endpoint = new RelayEndpoint()
  const ipc = new RelayIpc(endpoint)
  const contextBridge: ContextBridgeLike = { exposeInMainWorld() {} }
  const preload = createDesktopPreload(contextBridge, ipc)
  globalThis.dshDesktop = preload.bridge
  hostPlugin.internals.endpoint = endpoint
  const apiProxy = {
    sessions: {
      list: (request: { rpcId: string }) => Promise.resolve({
        rpcId: request.rpcId, result: { ok: true, value: { items: [] } },
      }),
    },
    host: {
      describe: (request: { rpcId: string }) => Promise.resolve({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: { version: 'composition', cwd: '/workspace', home: '/home', attachedSessions: 0, canOpenPath: false },
        },
      }),
    },
    events: {
      mux: (_request: unknown, signal: AbortSignal) => idleFrames(signal),
      host: (_request: unknown, signal: AbortSignal) => idleFrames(signal),
    },
  }
  const before = activeNetworkListeners()
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-connection-loader-'))
  const hostConfigPath = join(fixture, 'host.cordis.yml')
  const clientConfigPath = join(fixture, 'client.cordis.yml')
  writeFileSync(hostConfigPath, '- id: desktop-connection\n  name: cordis:desktop-connection\n')
  writeFileSync(clientConfigPath, '- id: desktop-connection\n  name: cordis:desktop-client-connection\n')
  let host: Awaited<ReturnType<typeof boot>> | undefined
  let client: Awaited<ReturnType<typeof boot>> | undefined
  try {
    host = await boot('desktop-connection-host-composition', hostConfigPath, undefined, (hostContext) => {
      hostContext.provide('apiProxy', apiProxy as never)
      expect('default' in hostPlugin).toBe(false)
      const loadedHostPlugin = hostContext.loader.unwrapExports(hostPlugin)
      expect(loadedHostPlugin).toBe(hostPlugin)
      hostContext.loader.builtins['desktop-connection'] = loadedHostPlugin
    }, bundleAnchor)
    host.connection.rpc.handle('/rpc', async (method: string, payload: unknown) => ({
      ok: true, value: { method, payload },
    }), { authority: 'loopback' })

    client = await boot('desktop-connection-client-composition', clientConfigPath, undefined, (clientContext) => {
      expect('default' in clientPlugin).toBe(false)
      const loadedClientPlugin = clientContext.loader.unwrapExports(clientPlugin)
      expect(loadedClientPlugin).toBe(clientPlugin)
      clientContext.loader.builtins['desktop-client-connection'] = loadedClientPlugin
    }, bundleAnchor)
    const clientConnection = client.get('connection') as unknown as ConnectionHandle
    expect(host.get('webServer')).toBeUndefined()
    expect(client.get('webServer')).toBeUndefined()
    expect(activeNetworkListeners()).toEqual(before)
    await expect(clientConnection.api.sessions.list({})).resolves.toMatchObject({
      result: { ok: true, value: { items: [] } },
    })
    await expect(clientConnection.rpc.call('/rpc', 'ping', { value: 1 })).resolves.toEqual({
      ok: true, value: { method: 'ping', payload: { value: 1 } },
    })
    const connected = new Promise<void>((resolve) => {
      const controller = clientConnection.start({
        onConnected(description) {
          expect(description.version).toBe('composition')
          controller.stop()
          resolve()
        },
      }, { streamOpenTimeoutMs: 500 })
    })
    await connected
  } finally {
    await client?.fiber.dispose()
    await host?.fiber.dispose()
    preload.dispose()
    rmSync(fixture, { recursive: true, force: true })
  }
  expect(endpoint.listenerCount('message')).toBe(0)
  expect(activeNetworkListeners()).toEqual(before)
})

function activeNetworkListeners(): string[] {
  const getActiveHandles = Reflect.get(process, '_getActiveHandles') as () => unknown[]
  const handles = getActiveHandles.call(process)
  return handles.flatMap((handle) => {
    if (typeof handle !== 'object' || handle === null || !('address' in handle)
      || typeof handle.address !== 'function') return []
    const address = handle.address() as unknown
    return address === null ? [] : [JSON.stringify(address)]
  }).toSorted()
}
