// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  SidebarFooterActionOwnerProps, SidebarRootComponentProps, SidebarSectionOwnerProps,
  SidebarSettingsOwnerProps,
} from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'

// English-dictionary translate stub: the shell renders the same copy the
// assertions below query by accessible name.
const t: SidebarRootComponentProps['t'] = key => (en as Record<string, string>)[key] ?? key

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// The shell never reads the global hooks itself, but they ride the standard
// props share; stub them as never-called functions.
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never

function mountShell({ collapsed = false, width = 300 }: { collapsed?: boolean; width?: number } = {}) {
  const startSession = vi.fn()
  const toggleSidebar = vi.fn()
  let regionOwner: SidebarSectionOwnerProps | undefined
  let settingsOwner: SidebarSettingsOwnerProps | undefined
  let footerActionOwner: SidebarFooterActionOwnerProps | undefined
  let current = { collapsed, width }
  const root = () => (
    <SidebarRoot
      collapsed={current.collapsed} width={current.width}
      useSessions={neverHook} useWorkspaces={neverHook}
      startSession={startSession} toggleSidebar={toggleSidebar} t={t}
      renderSlot={((
        key: string,
        owner: SidebarFooterActionOwnerProps | SidebarSectionOwnerProps | SidebarSettingsOwnerProps,
      ) => {
        if (key === 'sidebar.settings') {
          settingsOwner = owner
          return <div data-testid="settings-seat" />
        }
        if (key === 'sidebar.footer.action') {
          footerActionOwner = owner
          return <div data-testid="footer-action-seat" />
        }
        regionOwner = owner
        return <div data-testid="region" />
      }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    startSession,
    toggleSidebar,
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    settingsOwner: () => {
      if (settingsOwner === undefined) throw new Error('settings owner not rendered')
      return settingsOwner
    },
    footerActionOwner: () => {
      if (footerActionOwner === undefined) throw new Error('footer action owner not rendered')
      return footerActionOwner
    },
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('SidebarRoot shell', () => {
  it('routes New Session (capsule + wordmark) and the column toggle', () => {
    const b = mountShell()
    // Expanded, the wordmark and the capsule start a session; the compact
    // brand-row seam (CSS-hidden in the browser) adds its button to the
    // un-styled test DOM.
    const starters = screen.getAllByRole('button', { name: 'New session' })
    expect(starters).toHaveLength(3)
    expect(document.querySelector('[data-sidebar-new-session]')).toBe(starters[2])
    for (const button of starters) fireEvent.click(button)
    expect(b.startSession).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('keeps the wordmark in the first row by default and exposes the compact brand-row seam', () => {
    mountShell()
    const controlRow = document.querySelector('[data-sidebar-control-row]')
    const brandRow = document.querySelector('[data-sidebar-brand-row]')
    expect(controlRow).not.toBeNull()
    expect(brandRow).not.toBeNull()
    expect(controlRow?.querySelector('[data-sidebar-toggle]')?.getAttribute('aria-label')).toBe('Collapse sidebar')
    expect(controlRow?.querySelector('[data-sidebar-brand-inline]')?.getAttribute('aria-label')).toBe('New session')
    expect(brandRow?.querySelector('button')?.getAttribute('aria-label')).toBe('New session')
  })

  it('hands child seats no collapse compatibility state', () => {
    const b = mountShell()
    expect(b.regionOwner()).toEqual({})
    expect(b.settingsOwner()).toEqual({})
    expect(b.footerActionOwner()).toEqual({})
  })

  it('keeps the region mounted through the crossfade, then unmounts at the zero-width settle', () => {
    vi.useFakeTimers()
    const b = mountShell()
    b.rerender({ collapsed: true, width: 0 })
    // Content survives the crossfade window (frozen width, fading).
    expect(b.regionOwner()).toEqual({})
    vi.advanceTimersByTime(200)
    b.rerender({})
    // At settle the zero-width track carries nothing: the shell unmounts and
    // the frame's reveal control takes over (AppFrame owns that affordance).
    expect(screen.queryByTestId('region')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull()
  })

  it('renders nothing on a cold collapsed start (no rail, no crossfade classes)', () => {
    mountShell({ collapsed: true, width: 0 })
    expect(screen.queryByTestId('region')).toBeNull()
    expect(screen.queryByTestId('settings-seat')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('[data-sidebar-toggle]')).toBeNull()
  })
})
