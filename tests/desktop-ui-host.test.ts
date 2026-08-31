import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SIDEBAR_GLASS_EFFECT,
  SIDEBAR_GLASS_SETTINGS_NAMESPACE,
  SidebarGlassSettingsSchema,
  apply,
} from '../packages/ui/src/index.js'

const uiRequire = createRequire(new URL('../packages/ui/package.json', import.meta.url))
const { Context } = uiRequire('@deepseek-ai/cordis') as {
  Context: new () => Parameters<typeof apply>[0]
}
const { SettingsProvider } = uiRequire('@deepseek-ai/dsh-settings') as {
  SettingsProvider: new (context: Parameters<typeof apply>[0]) => object
}
const mountedContexts = new Set<InstanceType<typeof Context>>()

class MemorySettingsProvider extends SettingsProvider {
  readonly writable = false

  protected async load(): Promise<Record<string, unknown>> {
    return {}
  }

  protected async persist(): Promise<void> {}
}

afterEach(async () => {
  for (const context of mountedContexts) await context.fiber.dispose()
  mountedContexts.clear()
})

describe('desktop UI Host contribution', () => {
  it('registers a default-enabled, boolean-only setting through the settings service', () => {
    const registrations: Array<{ namespace: unknown; schema: unknown }> = []
    const settingsContext = {
      settings: {
        register(namespace: unknown, schema: unknown) {
          registrations.push({ namespace, schema })
          return { dispose: vi.fn() }
        },
      },
    }
    const inject = vi.fn((services: string[], setup: (context: typeof settingsContext) => void) => {
      if (services.includes('settings')) setup(settingsContext)
    })

    apply({ inject } as never)
    expect(inject).toHaveBeenCalledWith(['settings'], expect.any(Function))
    expect(registrations).toHaveLength(1)
    expect(String(registrations[0]?.namespace)).toBe(SIDEBAR_GLASS_SETTINGS_NAMESPACE)
    expect(SidebarGlassSettingsSchema()).toEqual({ enabled: DEFAULT_SIDEBAR_GLASS_EFFECT })
    expect(SidebarGlassSettingsSchema({ enabled: false })).toEqual({ enabled: false })
    expect(() => SidebarGlassSettingsSchema({ enabled: 'yes' as never })).toThrow()
  })

  it('removes the settings namespace when the Host contribution unloads', async () => {
    const context = new Context()
    mountedContexts.add(context)
    await context.plugin(MemorySettingsProvider)
    const contribution = context.plugin({ name: 'desktop-ui-host-test', apply })
    await contribution
    const settings = context.get('settings') as {
      describe(options: { redact: boolean }): Array<{ ns: string; value: unknown }>
    }

    expect(settings.describe({ redact: false })).toContainEqual(expect.objectContaining({
      ns: SIDEBAR_GLASS_SETTINGS_NAMESPACE,
      value: { enabled: true },
    }))

    await contribution.dispose()

    expect(settings.describe({ redact: false })).not.toContainEqual(expect.objectContaining({
      ns: SIDEBAR_GLASS_SETTINGS_NAMESPACE,
    }))
  })

  it('registers and disposes the official frontend asset channel through Connection', async () => {
    const dispose = vi.fn(async () => undefined)
    const handle = vi.fn(() => dispose)
    const effects: Array<() => void | (() => void | Promise<void>)> = []
    const uiContext = {
      clientModules: {
        graph: () => ({ rev: 'test', entries: [] }),
        clientPath: () => undefined,
      },
      connection: { rpc: { handle } },
      effect(setup: () => void | (() => void | Promise<void>)) {
        effects.push(setup)
      },
    }
    const settingsContext = {
      settings: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    }
    const inject = vi.fn((services: string[], setup: (context: never) => void) => {
      setup((services.includes('clientModules') ? uiContext : settingsContext) as never)
    })

    apply({ inject } as never)
    expect(inject).toHaveBeenCalledWith(['clientModules', 'connection'], expect.any(Function))
    expect(effects).toHaveLength(1)
    const cleanup = effects[0]?.()
    expect(handle).toHaveBeenCalledWith('/ui', expect.any(Function), { authority: 'loopback' })
    await (cleanup as () => Promise<void>)()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
