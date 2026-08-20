/** Appearance row store: snapshot-mirror action and the revision guard. */
import { describe, expect, it } from 'vitest'
import { createAppearanceRowStore } from '../src/client/settings-store.ts'

describe('createAppearanceRowStore', () => {
  it('init shape: system preference with revision at -1', () => {
    const store = createAppearanceRowStore().create()
    expect(store.getSnapshot()).toEqual({
      preference: 'system',
      revision: -1,
      sidebarGlassAvailable: false,
      sidebarGlassEnabled: true,
      sidebarGlassSystemOverride: false,
      sidebarGlassRevision: -1,
    })
  })

  it('sync mirrors the preference and advances the revision', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync('dark', 0)
    expect(store.getSnapshot()).toMatchObject({ preference: 'dark', revision: 0 })
    store.actions.sync('light', 2)
    expect(store.getSnapshot().preference).toBe('light')
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('revision guard drops stale and duplicate writes', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync('dark', 3)
    store.actions.sync('system', 2)
    store.actions.sync('system', 3)
    expect(store.getSnapshot().preference).toBe('dark')
    expect(store.getSnapshot().revision).toBe(3)
  })

  it('tracks the macOS contribution on an independent revision axis', () => {
    const store = createAppearanceRowStore().create()
    store.actions.syncSidebarGlass(true, false, true, 2)
    store.actions.sync('dark', 7)
    store.actions.syncSidebarGlass(true, true, false, 1)
    expect(store.getSnapshot()).toMatchObject({
      preference: 'dark',
      revision: 7,
      sidebarGlassAvailable: true,
      sidebarGlassEnabled: false,
      sidebarGlassSystemOverride: true,
      sidebarGlassRevision: 2,
    })
    store.actions.syncSidebarGlass(false, true, false, 3)
    expect(store.getSnapshot().sidebarGlassAvailable).toBe(false)
  })
})
