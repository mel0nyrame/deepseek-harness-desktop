import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface CapturedLayoutModule {
  apply(ctx: unknown): void
}

interface StoreDefinition {
  init(): { sidebar: number; sidebarLast?: number; details: number; narrow: boolean; narrowExpanded: boolean }
  actions: {
    setSidebar(state: ReturnType<StoreDefinition['init']>, width: number): void
    toggleSidebar(state: ReturnType<StoreDefinition['init']>): void
    setNarrow(state: ReturnType<StoreDefinition['init']>, narrow: boolean): void
  }
}

afterEach(() => { vi.unstubAllGlobals() })

function jsx(type: unknown, props: Record<string, unknown>) {
  return { type, props }
}

async function loadLayoutClient(): Promise<CapturedLayoutModule> {
  let loaded: CapturedLayoutModule | undefined
  const react = {
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, vi.fn()],
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: (callback: unknown) => callback,
    useEffect: vi.fn(),
    useLayoutEffect: vi.fn(),
  }
  vi.stubGlobal('window', {
    innerWidth: 1200,
    __ModuleLoader__: {
      load(moduleDefinition: { factory(require: (id: string) => unknown): CapturedLayoutModule }) {
        loaded = moduleDefinition.factory((id) => {
          if (id === 'react') return react
          if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol('Fragment') }
          if (id === '@deepseek-ai/dsh-client-runtime/client') {
            return { defineStore: (definition: StoreDefinition) => definition }
          }
          throw new Error(`unexpected layout dependency: ${id}`)
        })
      },
    },
  })
  const client = path.resolve('packages/ui/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js')
  await import(`${pathToFileURL(client).href}?desktop-layout-patch=${String(Date.now())}`)
  if (loaded === undefined) throw new Error('layout Client module did not register')
  return loaded
}

describe('desktop layout patch', () => {
  it('closes to zero width and restores the last dragged sidebar width', async () => {
    const layout = await loadLayoutClient()
    let registration: { store: () => StoreDefinition; component: (props: Record<string, unknown>) => unknown } | undefined
    let effectIndex = 0
    layout.apply({
      effect(setup: () => unknown) {
        effectIndex += 1
        if (effectIndex === 1) setup()
        return () => undefined
      },
      reflect: { provide: () => () => undefined },
      slots: {
        register(options: { store: () => StoreDefinition }, component: (props: Record<string, unknown>) => unknown) {
          registration = { store: options.store, component }
          return () => undefined
        },
      },
    })
    if (registration === undefined) throw new Error('layout root registration missing')

    const storeDefinition = registration.store()
    const state = storeDefinition.init()
    storeDefinition.actions.setSidebar(state, 372)
    storeDefinition.actions.toggleSidebar(state)
    expect(state).toMatchObject({ sidebar: 0, sidebarLast: 372 })
    storeDefinition.actions.toggleSidebar(state)
    expect(state).toMatchObject({ sidebar: 372, sidebarLast: 372 })

    storeDefinition.actions.setNarrow(state, true)
    storeDefinition.actions.toggleSidebar(state)
    expect(state).toMatchObject({ sidebar: 372, sidebarLast: 372, narrow: true, narrowExpanded: true })
    storeDefinition.actions.toggleSidebar(state)
    storeDefinition.actions.setNarrow(state, false)
    expect(state).toMatchObject({ sidebar: 372, sidebarLast: 372, narrow: false, narrowExpanded: false })

    state.sidebar = 0
    const frame = registration.component({
      useStore: (select: (value: typeof state) => unknown) => select(state),
      useSessions: (select: (value: { current?: string; byId: Record<string, unknown> }) => unknown) => select({ byId: {} }),
      actions: { closeDetails: vi.fn(), setNarrow: vi.fn(), setSidebar: vi.fn(), setDetails: vi.fn() },
      renderSlot: vi.fn(() => null),
    }) as { props: { style: { gridTemplateColumns: string; '--dsh-sidebar-width': string }; 'data-sidebar-collapsed': string } }
    expect(frame.props.style.gridTemplateColumns).toBe('0px minmax(0, 1fr) 0px')
    expect(frame.props.style['--dsh-sidebar-width']).toBe('0px')
    expect(frame.props['data-sidebar-collapsed']).toBe('true')
  })
})
