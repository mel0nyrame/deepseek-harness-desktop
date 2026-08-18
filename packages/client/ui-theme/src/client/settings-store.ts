/**
 * Appearance row slot store: a mirror of the theme service snapshot. The
 * plugin's apply-world change listener is the only writer; the row component
 * reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemePreference } from '../theme-settings.ts'

/** Store state mirrored from the theme snapshot. */
export interface AppearanceRowState {
  /** Persisted preference (selection state reads this, never the resolved active theme). */
  preference: ThemePreference
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
  /** Whether the macOS desktop composition contributes sidebar glass. */
  sidebarGlassAvailable: boolean
  /** Saved sidebar glass preference. */
  sidebarGlassEnabled: boolean
  /** Whether macOS currently overrides the visible effect. */
  sidebarGlassSystemOverride: boolean
  /** Independent material-runtime revision. */
  sidebarGlassRevision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type AppearanceRowActions = {
  sync: (draft: AppearanceRowState, preference: ThemePreference, revision: number) => void
  syncSidebarGlass: (
    draft: AppearanceRowState,
    available: boolean,
    enabled: boolean,
    systemOverride: boolean,
    revision: number,
  ) => void
}

/**
 * Declares the Appearance row state and write surface.
 * @returns the store handle.
 */
export function createAppearanceRowStore(): EngineStoreHandle<AppearanceRowState, AppearanceRowActions> {
  return defineStore({
    init: (): AppearanceRowState => ({
      preference: 'system',
      revision: -1,
      sidebarGlassAvailable: false,
      sidebarGlassEnabled: true,
      sidebarGlassSystemOverride: false,
      sidebarGlassRevision: -1,
    }),
    actions: {
      sync: (d, preference: ThemePreference, revision: number) => {
        if (revision <= d.revision) return
        d.preference = preference
        d.revision = revision
      },
      syncSidebarGlass: (d, available, enabled, systemOverride, revision) => {
        if (revision <= d.sidebarGlassRevision) return
        d.sidebarGlassAvailable = available
        d.sidebarGlassEnabled = enabled
        d.sidebarGlassSystemOverride = available && systemOverride
        d.sidebarGlassRevision = revision
      },
    },
  })
}
