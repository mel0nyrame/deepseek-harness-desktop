/** `settings.theme` namespace dictionaries (the Appearance row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'sidebarGlass.title': '侧栏玻璃效果',
  'sidebarGlass.description': '在侧栏后方使用 macOS 半透明材质。',
  'sidebarGlass.override': 'macOS“减少透明度”正在覆盖可见效果；已保存的偏好会保留。',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'sidebarGlass.title': 'Sidebar glass effect',
  'sidebarGlass.description': 'Use a translucent macOS material behind the sidebar.',
  'sidebarGlass.override': 'macOS Reduce Transparency is overriding the visible effect; your saved preference is preserved.',
} satisfies Record<ThemeKey, string>
