/** Sidebar shell style contracts shared with its slot-owned controls. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('SidebarRoot.module.css', () => {
  it('shares and cancels the wide shell trailing padding structurally', () => {
    const root = declarations('.root')
    expect(root?.get('--dsh-sidebar-inline-padding')).toBe('12px')
    expect(root?.get('padding')).toBe('6px var(--dsh-sidebar-inline-padding)')
    expect(declarations('.regionArea')?.get('margin-left')).toBe('-4px')
    expect(declarations('.regionArea')?.get('padding-left')).toBe('4px')
    expect(declarations('.regionArea')?.get('margin-right')).toBe(
      'calc(-1 * var(--dsh-sidebar-inline-padding))',
    )
  })

  it('collapses by crossfading the frozen wide content only (no rail geometry)', () => {
    expect(declarations('.fading > *')?.get('transition')).toBe('opacity 150ms var(--ds-ease-in-out)')
    expect(declarations('.fading > *')?.get('opacity')).toBe('0')
    expect(declarations('.wide')?.get('animation')).toBe('wide-in 200ms var(--ds-ease-in-out)')
    expect(css).toMatch(/@keyframes wide-in\s*\{\s*from\s*\{\s*opacity: 0;\s*}\s*}/)
    // Issue #33: the 56px compact rail is gone — no rail selectors, no rail
    // entry translations, no rail icon swap remain.
    expect(css).not.toContain('.collapsed')
    expect(css).not.toContain('.railIn')
    expect(css).not.toContain('rail-in')
    expect(css).not.toContain('56px')
  })

  it('keeps the wordmark in the first row by default and hides the compact brand-row seam', () => {
    expect(declarations('.logoRow')?.get('justify-content')).toBe('flex-end')
    expect(declarations('.logoRow')?.get('height')).toBe('60px')
    expect(declarations('.brandRow')?.get('display')).toBe('none')
  })

  it('respects reduced motion for the collapse crossfade', () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    expect(reduced).toContain('.fading > *')
    expect(reduced).toContain('animation: none')
  })
})
