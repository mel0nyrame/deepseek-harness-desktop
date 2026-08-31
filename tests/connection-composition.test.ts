import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '../packages/bundle/node_modules/@deepseek-ai/cordis/lib/types/index.d.ts'
import type { ConnectionHandle, ConnectionTransport } from '../packages/connection/src/carrier.js'
import type {
  DesktopCapabilityValue,
  DesktopChildEndpoint,
  DesktopChildMessage,
} from '../packages/connection/src/index.js'
import { parseDesktopCapabilityRequest } from '../packages/connection/src/index.js'
import { createDesktopPreload, type ContextBridgeLike, type IpcRendererLike } from '../packages/connection/src/preload.js'

interface DesktopClientExports {
  createConnectionHandle(transport: ConnectionTransport): ConnectionHandle
  createFetchConnectionRpc(fetcher: typeof fetch): ConnectionTransport['rpc']
  readonly internals: {
    createConnectionHandle(transport: ConnectionTransport): ConnectionHandle
    createFetchConnectionRpc(fetcher: typeof fetch): ConnectionTransport['rpc']
  }
}

interface HostPluginExports {
  readonly internals: {
    endpoint: DesktopChildEndpoint
  }
}

interface PickerModuleExports {
  default: new (ctx: Context) => { capability(): { kind: string } }
}

interface GatewayModuleExports {
  readonly name: string
  readonly inject: string[]
  apply(ctx: Context): void
}

const bundleRequire = createRequire(new URL('../packages/bundle/package.json', import.meta.url))
const bundleAnchor = new URL('../packages/bundle/package.json', import.meta.url).href
const hostPluginUrl = pathToFileURL(bundleRequire.resolve('@dsh-desktop/connection')).href
const clientPluginUrl = pathToFileURL(bundleRequire.resolve('@dsh-desktop/connection/client')).href
const pickerModuleUrl = pathToFileURL(bundleRequire.resolve('@dsh-desktop/native')).href
const gatewayModuleUrl = pathToFileURL(bundleRequire.resolve('@dsh-desktop/native/gateway')).href
const { boot } = bundleRequire('@deepseek-ai/dsh-app-boot') as {
  boot(
    binName: string,
    absoluteConfigPath: string,
    patches: undefined,
    prepare: (ctx: Context) => Promise<void> | void,
    bareModuleBaseUrl: string,
  ): Promise<Context>
}
const officialGateway = bundleRequire('@deepseek-ai/dsh-host-apiproxy') as {
  ApiProxyService: { inject: readonly string[] }
}

let desktopClientImports = 0

async function loadDesktopClientExports(): Promise<DesktopClientExports> {
  interface ClientModule {
    readonly id: string
    factory(require: (id: string) => unknown): unknown
  }
  const modules = new Map<string, ClientModule>()
  const exports = new Map<string, unknown>()
  Object.assign(globalThis, {
    window: {
      __ModuleLoader__: {
        load(module: ClientModule) {
          modules.set(module.id, module)
        },
      },
    },
  })
  desktopClientImports += 1
  await import(`${clientPluginUrl}?connection-composition-${String(desktopClientImports)}`)

  const resolveModule = (requestedId: string): unknown => {
    const id = requestedId === '@deepseek-ai/dsh-client-connection/client'
      ? '@deepseek-ai/dsh-client-connection'
      : requestedId
    if (exports.has(id)) return exports.get(id)
    const module = modules.get(id)
    if (module === undefined) throw new Error(`unexpected client dependency: ${requestedId}`)
    const value = module.factory(resolveModule)
    exports.set(id, value)
    return value
  }
  return resolveModule('@dsh-desktop/connection') as DesktopClientExports
}

class RelayEndpoint extends EventEmitter implements DesktopChildEndpoint {
  connected = true
  relay: ((message: DesktopChildMessage) => void) | undefined

  /** Scripted main-side settlements, consumed in request order. */
  readonly scriptedSettlements: Array<DesktopCapabilityValue | { readonly error: string }> = []
  readonly capabilityRequests: Array<{ readonly id: string; readonly action: string }> = []
  holdCapabilityRequests = false

  send(message: DesktopChildMessage, callback?: (error: Error | null) => void): boolean {
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'capability-request') {
      const parsed = parseDesktopCapabilityRequest(message)
      if (parsed === undefined) throw new Error('composition relay received an invalid capability request')
      this.capabilityRequests.push({ id: parsed.id, action: parsed.action })
      if (this.holdCapabilityRequests) {
        callback?.(null)
        return true
      }
      const settlement = this.scriptedSettlements.shift()
      if (settlement === undefined) throw new Error(`no scripted settlement for ${parsed.action}`)
      queueMicrotask(() => {
        if ('error' in settlement) {
          this.emit('message', { type: 'capability-error', id: parsed.id, message: settlement.error })
        } else {
          this.emit('message', { type: 'capability-response', id: parsed.id, ...settlement })
        }
      })
      callback?.(null)
      return true
    }
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
    if (message.type === 'connection-ready') return
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
  const hostPlugin = await import(hostPluginUrl) as HostPluginExports
  const clientPlugin = await loadDesktopClientExports()
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

it('composes the desktop picker and gateway over the real stack with shell-side answers', async () => {
  const nativeChannelInternals = await import(new URL('../packages/native/lib/channel.js', import.meta.url).href) as {
    internals: { endpoint: DesktopChildEndpoint }
  }
  const pickerModule = await import(pickerModuleUrl) as PickerModuleExports
  const gatewayModule = await import(gatewayModuleUrl) as GatewayModuleExports
  const hostPlugin = await import(hostPluginUrl) as HostPluginExports
  // The desktop gateway mirrors the official gateway's service prerequisites.
  expect([...gatewayModule.inject]).toEqual([...officialGateway.ApiProxyService.inject])

  const endpoint = new RelayEndpoint()
  const previousNativeEndpoint = nativeChannelInternals.internals.endpoint
  nativeChannelInternals.internals.endpoint = endpoint
  const previousHostEndpoint = hostPlugin.internals.endpoint
  hostPlugin.internals.endpoint = endpoint
  let host: Awaited<ReturnType<typeof boot>> | undefined
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-native-loader-'))
  const hostConfigPath = join(fixture, 'native-host.cordis.yml')
  writeFileSync(hostConfigPath, [
    '- id: desktop-picker',
    '  name: cordis:desktop-picker',
    '- id: desktop-gateway',
    '  name: cordis:desktop-gateway',
    '- id: desktop-connection',
    '  name: cordis:desktop-connection',
    '',
  ].join('\n'))

  try {
    host = await boot('desktop-native-composition', hostConfigPath, undefined, (hostContext) => {
      for (const [name, value] of Object.entries({
        agentDefaultModel: {
          currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
          saveSelection: () => Promise.resolve(),
        },
        agents: {},
        attachments: {},
        llm: {},
        sessions: {},
        subagents: {},
        sessionQuery: {},
        tools: {},
        userQuestions: {
          // createApiProxy registers its question provider eagerly; the stub
          // records nothing because these tests ask no questions.
          registerProvider: () => () => {},
        },
        workspaceRegistry: {},
      })) {
        hostContext.provide(name, value as never)
      }
      const pickerBootstrap = {
        name: 'desktop-picker',
        inject: [] as string[],
        apply(pickerContext: Context): void {
          void new pickerModule.default(pickerContext)
        },
      }
      hostContext.loader.builtins['desktop-picker']
        = hostContext.loader.unwrapExports(pickerBootstrap) ?? pickerBootstrap
      hostContext.loader.builtins['desktop-gateway'] = gatewayModule
      hostContext.loader.builtins['desktop-connection'] = hostPlugin
    }, bundleAnchor)

    const api = host.get('apiProxy') as unknown
    expect(typeof api).toBe('object')

    endpoint.scriptedSettlements.push({ kind: 'path', path: '/Users/mac/workspaces/composed' })

    const ipc = new RelayIpc(endpoint)
    const contextBridge: ContextBridgeLike = { exposeInMainWorld() {} }
    const preload = createDesktopPreload(contextBridge, ipc)
    globalThis.dshDesktop = preload.bridge

    const clientPlugin = await loadDesktopClientExports()
    const clientConfigPath = join(fixture, 'native-client.cordis.yml')
    writeFileSync(clientConfigPath, '- id: desktop-connection\n  name: cordis:desktop-client-connection\n')
    let client: Awaited<ReturnType<typeof boot>> | undefined
    try {
      client = await boot('desktop-native-client', clientConfigPath, undefined, (clientContext) => {
        clientContext.loader.builtins['desktop-client-connection']
          = clientContext.loader.unwrapExports(clientPlugin) ?? clientPlugin
      }, bundleAnchor)
      const connection = client.get('connection') as unknown as ConnectionHandle

      await expect(connection.api.host.pickDirectory({})).resolves.toMatchObject({
        result: { ok: true, value: { path: '/Users/mac/workspaces/composed' } },
      })

      // Browse-only methods stay hidden behind the native capability contract.
      await expect(connection.api.host.listDirectory({})).resolves.toMatchObject({
        result: { ok: false, error: { code: 'directory-picker-unavailable' } },
      })

      endpoint.scriptedSettlements.push({ kind: 'opened' })
      await expect(connection.api.host.openPath({ path: '/tmp/report.pdf' })).resolves.toMatchObject({
        result: { ok: true, value: { opened: true } },
      })

      endpoint.scriptedSettlements.push({ error: 'shell handoff refused' })
      await expect(connection.api.host.openPath({ path: '/tmp/mystery.bin' })).resolves.toMatchObject({
        result: {
          ok: false,
          error: { message: expect.stringContaining('path open failed: shell handoff refused') },
        },
      })

      expect(endpoint.capabilityRequests).toHaveLength(3)

      endpoint.holdCapabilityRequests = true
      const pendingOpen = connection.api.host.openPath({ path: '/tmp/held.pdf' })
      await host?.fiber.dispose()
      await expect(pendingOpen).resolves.toMatchObject({
        result: { ok: false, error: { code: 'cancelled' } },
      })
    } finally {
      await client?.fiber.dispose()
      preload.dispose()
      globalThis.dshDesktop = undefined
    }
  } finally {
    nativeChannelInternals.internals.endpoint = previousNativeEndpoint
    hostPlugin.internals.endpoint = previousHostEndpoint
    await host?.fiber.dispose()
    rmSync(fixture, { recursive: true, force: true })
  }
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
