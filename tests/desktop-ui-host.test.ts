import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SIDEBAR_GLASS_EFFECT,
  SIDEBAR_GLASS_SETTINGS_NAMESPACE,
  SidebarGlassSettingsSchema,
  apply,
} from '../packages/ui/src/index.js'

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
    const inject = vi.fn((_services: string[], setup: (context: typeof settingsContext) => void) => {
      setup(settingsContext)
    })

    apply({ inject } as never)
    expect(inject).toHaveBeenCalledWith(['settings'], expect.any(Function))
    expect(registrations).toHaveLength(1)
    expect(String(registrations[0]?.namespace)).toBe(SIDEBAR_GLASS_SETTINGS_NAMESPACE)
    expect(SidebarGlassSettingsSchema()).toEqual({ enabled: DEFAULT_SIDEBAR_GLASS_EFFECT })
    expect(SidebarGlassSettingsSchema({ enabled: false })).toEqual({ enabled: false })
    expect(() => SidebarGlassSettingsSchema({ enabled: 'yes' as never })).toThrow()
  })
})
