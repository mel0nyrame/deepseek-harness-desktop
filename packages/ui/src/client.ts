/** Client contributions for native window chrome, material, and settings UI. */

import { createElement, type ChangeEvent, type ComponentType, type ReactElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import {
  SIDEBAR_GLASS_SETTINGS_NAMESPACE,
  type SidebarGlassSettings,
} from './contract.js'
import {
  DesktopSurfaceRuntime,
  type NativeThemeBridgeLike,
  type SidebarGlassSettingsScopeLike,
} from './runtime.js'
import {
  installDesktopSurfaceStyles,
  type DesktopSurfaceDocumentLike,
} from './surface.js'

export const name = 'desktop-ui'
export const inject = ['slots', 'locale', 'settingsScope', 'theme', 'layout']
export const SETTINGS_NS = 'desktop.ui'

type DesktopUiKey =
  | 'sidebar.collapse'
  | 'sidebar.expand'
  | 'glass.title'
  | 'glass.description'
  | 'glass.reduced'
  | 'glass.unavailable'

const en: Record<DesktopUiKey, string> = {
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.expand': 'Expand sidebar',
  'glass.title': 'Translucent sidebar',
  'glass.description': 'Use the macOS window material behind the sidebar.',
  'glass.reduced': 'Reduce Transparency is enabled in macOS.',
  'glass.unavailable': 'Available in the macOS desktop app.',
}

const zh: Record<DesktopUiKey, string> = {
  'sidebar.collapse': '收起侧边栏',
  'sidebar.expand': '展开侧边栏',
  'glass.title': '半透明侧边栏',
  'glass.description': '在侧边栏后使用 macOS 窗口材质。',
  'glass.reduced': 'macOS 已启用“降低透明度”。',
  'glass.unavailable': '仅在 macOS 桌面应用中可用。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'desktop.ui': DesktopUiKey
  }
}

declare global {
  var dshNativeTheme: NativeThemeBridgeLike | undefined
}

interface DesktopWindowChromeInjected {
  BrandWordmark: ComponentType<{ size?: number }>
  PanelIcon: ComponentType<{ size?: number }>
  toggleSidebar(): void
}

type DesktopWindowChromeProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'desktop.ui'>
  & DesktopWindowChromeInjected

interface SidebarGlassRowInjected {
  hooks: { desktopSurface: DesktopSurfaceRuntime }
  setEnabled(enabled: boolean): void
}

type SidebarGlassRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'desktop.ui'>
  & InjectFace<SidebarGlassRowInjected>

/** Render additive compact chrome above the official sidebar contribution. */
export function DesktopWindowChrome({ BrandWordmark, PanelIcon, toggleSidebar, t }: DesktopWindowChromeProps): ReactElement {
  const collapse = createElement('button', {
    type: 'button',
    className: 'dsh-desktop-chrome-button',
    'data-desktop-sidebar-toggle': '',
    'aria-label': t('sidebar.collapse'),
    onClick: toggleSidebar,
  }, createElement(PanelIcon, { size: 16 }))
  const reveal = createElement('button', {
    type: 'button',
    className: 'dsh-desktop-chrome-button',
    'data-desktop-sidebar-reveal': '',
    'aria-label': t('sidebar.expand'),
    onClick: toggleSidebar,
  }, createElement(PanelIcon, { size: 16 }))
  return createElement('div', { 'data-desktop-window-chrome': '' },
    createElement('div', { 'data-desktop-sidebar-control-row': '' },
      collapse,
    ),
    createElement('div', {
      className: 'dsh-desktop-chrome-brand',
      'data-desktop-sidebar-brand-row': '',
      role: 'img',
      'aria-label': 'deepseek HARNESS',
    }, createElement(BrandWordmark, { size: 24 })),
    reveal,
  )
}

/** Render the durable sidebar material preference in General settings. */
export function SidebarGlassRow({ useDesktopSurface, setEnabled, t }: SidebarGlassRowProps): ReactElement {
  const snapshot = useDesktopSurface(value => value)
  const description = !snapshot.available
    ? t('glass.unavailable')
    : snapshot.systemOverride
      ? t('glass.reduced')
      : t('glass.description')
  return createElement('label', { className: 'dsh-desktop-glass-row' },
    createElement('span', { className: 'dsh-desktop-glass-row-text' },
      createElement('span', { className: 'dsh-desktop-glass-row-title' }, t('glass.title')),
      createElement('span', { className: 'dsh-desktop-glass-row-description' }, description),
    ),
    createElement('input', {
      type: 'checkbox',
      checked: snapshot.enabled,
      disabled: !snapshot.available,
      onChange: (event: ChangeEvent<HTMLInputElement>) => { setEnabled(event.currentTarget.checked) },
    }),
  )
}

export interface DesktopUiClientEnvironment {
  readonly nativeTheme: NativeThemeBridgeLike
  readonly document: DesktopSurfaceDocumentLike
  readonly primitives: Pick<DesktopWindowChromeInjected, 'BrandWordmark' | 'PanelIcon'>
}

export type DesktopUiClientContext = ClientContext & {
  readonly locale: LocaleRuntime
  readonly layout: ILayout
  readonly settingsScope: SettingsScopeBinder
  readonly theme: ThemeRuntime
}

/** Apply the Client plugin through explicit browser adapters for deterministic lifecycle tests. */
export function applyWithEnvironment(ctx: DesktopUiClientContext, environment: DesktopUiClientEnvironment): void {
  const settings = ctx.settingsScope.bind<SidebarGlassSettings>({
    namespace: SIDEBAR_GLASS_SETTINGS_NAMESPACE,
  }) as SidebarGlassSettingsScopeLike
  const surface = new DesktopSurfaceRuntime(settings, environment.nativeTheme, environment.document.body)
  ctx.effect(() => () => { surface.dispose() }, 'desktop-ui: surface runtime')
  ctx.effect(
    () => installDesktopSurfaceStyles(environment.document),
    'desktop-ui: surface styles',
  )
  ctx.effect(
    () => ctx.locale.register(SETTINGS_NS, { zh, en }),
    'desktop-ui: dictionaries',
  )

  let lastPreference: 'light' | 'dark' | 'system' | undefined
  const syncNativePreference = (snapshot: { readonly preference: unknown }): void => {
    const preference = snapshot.preference
    if ((preference !== 'light' && preference !== 'dark' && preference !== 'system')
      || preference === lastPreference) return
    lastPreference = preference
    environment.nativeTheme.setPreference(preference)
  }
  ctx.effect(
    () => ctx.on('theme/change', syncNativePreference),
    'desktop-ui: native theme synchronization',
  )
  syncNativePreference(ctx.theme.getTheme())

  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'desktop-window-chrome',
      order: -100,
      locale: SETTINGS_NS,
      inject: (): DesktopWindowChromeInjected => ({
        ...environment.primitives,
        toggleSidebar: () => { ctx.layout.toggleSidebar() },
      }),
    }, DesktopWindowChrome)),
    'desktop-ui: window chrome contribution',
  )
  ctx.effect(
    () => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'desktop-sidebar-glass',
      order: 15,
      locale: SETTINGS_NS,
      inject: (): SidebarGlassRowInjected => ({
        hooks: { desktopSurface: surface },
        setEnabled: enabled => { surface.setEnabled(enabled) },
      }),
    }, SidebarGlassRow)),
    'desktop-ui: sidebar glass settings contribution',
  )
}
