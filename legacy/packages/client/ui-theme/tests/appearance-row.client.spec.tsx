// @vitest-environment jsdom
/** AppearanceRow behavior: three cubes, selection follows the persisted
 * preference, clicks drive setTheme. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { AppearanceRow } from '../src/client/AppearanceRow.tsx'
import type { AppearanceRowComponentProps } from '../src/client/AppearanceRow.tsx'
import { createAppearanceRowStore } from '../src/client/settings-store.ts'
import type { ThemePreference } from '../src/client/index.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'sidebarGlass.title': 'Sidebar glass effect',
  'sidebarGlass.description': 'Use a translucent macOS material behind the sidebar.',
  'sidebarGlass.override': 'macOS Reduce Transparency is overriding the visible effect; your saved preference is preserved.',
}

/** Empty global standard-kit hooks (the row reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function mount(
  preference: ThemePreference = 'system',
  glass?: { enabled: boolean; systemOverride: boolean },
) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createAppearanceRowStore().create()
  store.actions.sync(preference, 0)
  if (glass !== undefined) {
    store.actions.syncSidebarGlass(true, glass.enabled, glass.systemOverride, 0)
  }
  const setTheme = vi.fn()
  const setSidebarGlassEffect = vi.fn()
  const props: AppearanceRowComponentProps = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setTheme,
    setSidebarGlassEffect,
  }
  render(<AppearanceRow {...props} />)
  return { store, setTheme, setSidebarGlassEffect }
}

const pressed = (name: RegExp): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('AppearanceRow', () => {
  it('renders the title and three cubes with the preference cube selected', () => {
    mount('dark')
    expect(screen.getByText('Appearance')).toBeDefined()
    expect(document.querySelector('[data-theme-preference="light"]')).not.toBeNull()
    expect(document.querySelector('[data-theme-preference="dark"]')).not.toBeNull()
    expect(document.querySelector('[data-theme-preference="system"]')).not.toBeNull()
    expect(pressed(/Dark/)).toBe('true')
    expect(pressed(/Light/)).toBe('false')
    expect(pressed(/System/)).toBe('false')
  })

  it('click drives setTheme; selection follows the store mirror, not the click echo', () => {
    const b = mount('dark')
    fireEvent.click(screen.getByRole('button', { name: /Light/ }))
    expect(b.setTheme).toHaveBeenCalledWith('light')
    // No store write yet: selection is unchanged.
    expect(pressed(/Dark/)).toBe('true')
    act(() => { b.store.actions.sync('light', 1) })
    expect(pressed(/Light/)).toBe('true')
    expect(pressed(/Dark/)).toBe('false')
  })

  it('renders the macOS switch below theme selection and follows the saved preference echo', () => {
    const mounted = mount('system', { enabled: true, systemOverride: false })
    const control = screen.getByRole('switch', { name: 'Sidebar glass effect' })
    expect(control.getAttribute('data-sidebar-glass-toggle')).toBe('')
    expect(control.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Use a translucent macOS material behind the sidebar.')).toBeDefined()
    fireEvent.click(control)
    expect(mounted.setSidebarGlassEffect).toHaveBeenCalledWith(false)
    expect(control.getAttribute('aria-checked')).toBe('true')
    act(() => { mounted.store.actions.syncSidebarGlass(true, false, false, 1) })
    expect(control.getAttribute('aria-checked')).toBe('false')
  })

  it('explains Reduce Transparency without changing the saved checked state', () => {
    mount('dark', { enabled: true, systemOverride: true })
    expect(screen.getByRole('switch', { name: 'Sidebar glass effect' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('Reduce Transparency')
  })

  it('does not render a non-functional switch outside the macOS contribution', () => {
    mount('light')
    expect(screen.queryByRole('switch', { name: 'Sidebar glass effect' })).toBeNull()
  })
})
