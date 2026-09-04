import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface ElementNode {
  readonly type?: unknown
  readonly props?: Record<string, unknown>
}

interface SidebarClient {
  apply(ctx: unknown): void
}

function jsx(type: unknown, props: Record<string, unknown>) {
  return { type, props }
}

function elementNodes(value: unknown): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap(elementNodes)
  if (typeof value !== 'object' || value === null) return []
  const element = value as ElementNode
  return [element, ...elementNodes(element.props?.children)]
}

async function loadPublishedSidebar(): Promise<SidebarClient> {
  let loaded: SidebarClient | undefined
  const bundleRequire = createRequire(path.resolve('packages/bundle/package.json'))
  const packageFile = bundleRequire.resolve('@deepseek-ai/dsh-client-ui-sidebar/package.json')
  const clientFile = path.join(path.dirname(packageFile), 'lib', 'client.js')
  vi.stubGlobal('document', {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => undefined },
  })
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    __ModuleLoader__: {
      load(definition: { factory(requireModule: (id: string) => unknown): SidebarClient }) {
        loaded = definition.factory((id) => {
          if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol('Fragment') }
          if (id === 'react') {
            return {
              useState: (initial: unknown) => [initial, vi.fn()],
              useEffect: vi.fn(),
              useRef: (initial: unknown) => ({ current: initial }),
            }
          }
          if (id === '@deepseek-ai/dsh-client-ui-primitives') {
            return new Proxy({}, { get: (_target, property) => String(property) })
          }
          throw new Error(`unexpected sidebar dependency: ${id}`)
        })
      },
    },
  })
  await import(`${pathToFileURL(clientFile).href}?desktop-sidebar=${String(Date.now())}`)
  if (loaded === undefined) throw new Error('published sidebar Client module did not register')
  return loaded
}

afterEach(() => { vi.unstubAllGlobals() })

describe('published sidebar with desktop layout contribution', () => {
  it('retains official labels, workspace counts, slots, and toggle interaction', async () => {
    const sidebar = await loadPublishedSidebar()
    let component: ((props: Record<string, unknown>) => unknown) | undefined
    let registration: Record<string, unknown> | undefined
    sidebar.apply({
      effect(setup: () => unknown) { setup(); return () => undefined },
      locale: { register: vi.fn(() => () => undefined) },
      slots: {
        register(options: Record<string, unknown>, candidate: (props: Record<string, unknown>) => unknown) {
          registration = options
          component = candidate
          return () => undefined
        },
      },
      layout: { toggleSidebar: vi.fn() },
      workspaces: { startSession: vi.fn() },
    })
    if (component === undefined || registration === undefined) {
      throw new Error('published sidebar registration missing')
    }

    const toggleSidebar = vi.fn()
    const workspaceOccupant = jsx('span', {
      'data-official-workspace-count': '3',
      children: 'Workspace · 3 sessions',
    })
    const renderSlot = vi.fn((name: string) => name === 'sidebar.workspaces' ? workspaceOccupant : null)
    const tree = component({
      collapsed: false,
      width: 350,
      startSession: vi.fn(),
      toggleSidebar,
      t: (key: string) => ({
        'session.new': 'New Session',
        'session.new.label': 'New session',
        'toggle.open': 'Open sidebar',
        'toggle.collapse': 'Collapse sidebar',
      })[key] ?? key,
      renderSlot,
    })
    const nodes = elementNodes(tree)
    expect(nodes.some(node => node.props?.['data-sidebar-header'] === '')).toBe(true)
    const toggle = nodes.find(node => node.type === 'button'
      && node.props?.['aria-label'] === 'Collapse sidebar')
    const onClick = toggle?.props?.onClick
    expect(onClick).toBeTypeOf('function')
    if (typeof onClick !== 'function') throw new Error('published sidebar toggle has no click action')
    onClick()
    expect(toggleSidebar).toHaveBeenCalledOnce()
    expect(nodes.some(node => node.props?.children === 'New Session')).toBe(true)
    expect(nodes).toContain(workspaceOccupant)
    expect(renderSlot).toHaveBeenCalledWith('sidebar.workspaces', {
      wide: true,
      expandSidebar: expect.any(Function),
    })
    expect(registration.children).toMatchObject({
      'sidebar.brand.mark': { kind: 'single' },
      'sidebar.brand.name': { kind: 'single' },
      'sidebar.workspaces': { kind: 'single' },
      'sidebar.settings': { kind: 'single' },
    })
  })
})
