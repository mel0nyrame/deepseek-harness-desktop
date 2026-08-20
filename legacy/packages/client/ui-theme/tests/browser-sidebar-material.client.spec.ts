// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserSidebarMaterialEnvironment } from '../src/client/browser-sidebar-material.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.body.dataset.dshPlatform
  delete document.body.dataset.dshTransparency
  delete document.body.dataset.dshSidebarMaterial
})

describe('BrowserSidebarMaterialEnvironment', () => {
  it('reads renderer facts and projects material only on macOS', () => {
    document.body.dataset.dshPlatform = 'darwin'
    document.body.dataset.dshTransparency = 'reduced'
    const environment = new BrowserSidebarMaterialEnvironment(() => 'dark')

    expect(environment.getFacts()).toEqual({
      platform: 'darwin',
      reducedTransparency: true,
      colorScheme: 'dark',
    })
    environment.apply('opaque-dark')
    expect(document.body.dataset.dshSidebarMaterial).toBe('opaque-dark')
    document.body.dataset.dshPlatform = 'linux'
    environment.apply('opaque-dark')
    expect(document.body.dataset.dshSidebarMaterial).toBeUndefined()
  })

  it('contains a failing observer and still notifies later observers', () => {
    const environment = new BrowserSidebarMaterialEnvironment(() => 'light')
    const failure = new Error('broken observer')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const later = vi.fn()
    environment.subscribe(() => { throw failure })
    environment.subscribe(later)

    environment.refresh()

    expect(error).toHaveBeenCalledWith('[ui-theme] sidebar material listener failed:', failure)
    expect(later).toHaveBeenCalledOnce()
  })

  it('stays inert without a DOM or MutationObserver', () => {
    const environment = new BrowserSidebarMaterialEnvironment(() => 'light')
    vi.stubGlobal('document', undefined)

    expect(environment.getFacts()).toEqual({
      platform: '',
      reducedTransparency: false,
      colorScheme: 'light',
    })
    expect(() => { environment.apply('glass-light') }).not.toThrow()
    const disposeWithoutDocument = environment.subscribe(() => undefined)
    disposeWithoutDocument()

    vi.unstubAllGlobals()
    vi.stubGlobal('MutationObserver', undefined)
    const disposeWithoutObserver = environment.subscribe(() => undefined)
    disposeWithoutObserver()
  })

  it('shares one mutation observer until the final subscriber leaves', () => {
    const disconnect = vi.fn()
    const observe = vi.fn()
    const observer = vi.fn(function (this: MutationObserver) {
      return { disconnect, observe } as unknown as MutationObserver
    })
    vi.stubGlobal('MutationObserver', observer)
    const environment = new BrowserSidebarMaterialEnvironment(() => 'light')

    const disposeFirst = environment.subscribe(() => undefined)
    const disposeLast = environment.subscribe(() => undefined)
    expect(observer).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledWith(document.body, {
      attributes: true,
      attributeFilter: ['data-dsh-platform', 'data-dsh-transparency'],
    })
    disposeFirst()
    expect(disconnect).not.toHaveBeenCalled()
    disposeLast()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
