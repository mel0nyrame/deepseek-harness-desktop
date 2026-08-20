/** `layout` namespace dictionaries: shell controls copy (the collapsed reveal control). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'toggle.open': '打开侧边栏',
} satisfies Record<string, string>

/** The layout namespace key union. */
export type LayoutKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'toggle.open': 'Open sidebar',
} satisfies Record<LayoutKey, string>
