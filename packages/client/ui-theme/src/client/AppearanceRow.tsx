/**
 * Appearance preference row registered into the General section item slot:
 * three theme cubes plus the durable sidebar-material switch when the macOS
 * Host contribution is ready. Selection follows persisted preferences, never
 * only their resolved visual effects.
 */
import clsx from 'clsx'
import {
  IconDarkOutline16, IconFollowsystemOutline16, IconLightOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemePreference } from '../theme-settings.ts'
import type { ThemeKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createAppearanceRowStore } from './settings-store.ts'
import css from './AppearanceRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface AppearanceRowInjected {
  /** Switch the theme preference. */
  setTheme: (id: ThemePreference) => void
  /** Switch the saved macOS sidebar glass preference. */
  setSidebarGlassEffect: (enabled: boolean) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type AppearanceRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createAppearanceRowStore>>
  & PropsLocale<'settings.theme'> & AppearanceRowInjected

/** Cube order and icons (figma 501:30015-30017: Light, Dark, System). */
const CUBES: readonly { id: ThemePreference; labelKey: ThemeKey; Icon: typeof IconLightOutline16 }[] = [
  { id: 'light', labelKey: 'appearance.light', Icon: IconLightOutline16 },
  { id: 'dark', labelKey: 'appearance.dark', Icon: IconDarkOutline16 },
  { id: 'system', labelKey: 'appearance.system', Icon: IconFollowsystemOutline16 },
]

/**
 * Render the Appearance row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function AppearanceRow({ t, setTheme, setSidebarGlassEffect, useStore }: AppearanceRowComponentProps) {
  const preference = useStore(s => s.preference)
  const sidebarGlassAvailable = useStore(s => s.sidebarGlassAvailable)
  const sidebarGlassEnabled = useStore(s => s.sidebarGlassEnabled)
  const sidebarGlassSystemOverride = useStore(s => s.sidebarGlassSystemOverride)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('appearance.title')}</div>
      <div className={css.cubeRow}>
        {CUBES.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            className={clsx(css.themeCube, preference === id && css.selected)}
            data-theme-preference={id}
            aria-pressed={preference === id}
            onClick={() => { setTheme(id) }}
          >
            <Icon />
            {t(labelKey)}
          </button>
        ))}
      </div>
      {sidebarGlassAvailable && (
        <div className={css.glassRow}>
          <div className={css.glassCopy}>
            <div className={css.glassTitle}>{t('sidebarGlass.title')}</div>
            <p className={css.glassDescription}>{t('sidebarGlass.description')}</p>
            {sidebarGlassSystemOverride && (
              <p className={css.glassOverride} role="status">{t('sidebarGlass.override')}</p>
            )}
          </div>
          <button
            type="button"
            role="switch"
            data-sidebar-glass-toggle=""
            aria-label={t('sidebarGlass.title')}
            aria-checked={sidebarGlassEnabled}
            className={css.switch}
            onClick={() => { setSidebarGlassEffect(!sidebarGlassEnabled) }}
          >
            <span className={css.switchThumb} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}
