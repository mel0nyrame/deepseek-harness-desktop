import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNativeThemePreload,
  desktopWindowOptions,
  isRequestedWindowSizeSettled,
  installNativeThemeHost,
  parseRendererThemePreference,
  rendererSurfaceState,
  waitForWindowMove,
  type NativeThemeContextBridgeLike,
  type NativeThemeIpcRendererLike,
  type NativeThemeHostLike,
  type NativeThemeIpcMainLike,
  type NativeWindowHostLike,
} from '../apps/desktop/src/native-window.js'

afterEach(() => {
  vi.useRealTimers()
})

class FakeEmitter {
  protected readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0)
  }
}

describe('desktop native window boundary', () => {
  it('removes the native move listener and timer after movement or timeout', async () => {
    vi.useFakeTimers()
    const window = new FakeEmitter()

    const moved = waitForWindowMove(window, 15_000)
    expect(window.listenerCount()).toBe(1)
    window.emit('move')
    await expect(moved).resolves.toBe(true)
    expect(window.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    const timedOut = waitForWindowMove(window, 3_000)
    expect(window.listenerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(timedOut).resolves.toBe(false)
    expect(window.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the compact macOS chrome and keeps other platforms opaque', () => {
    expect(desktopWindowOptions('darwin')).toEqual({
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 640,
      backgroundColor: '#00000000',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 14 },
      transparent: true,
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
    })
    expect(desktopWindowOptions('linux')).toEqual({ backgroundColor: '#f9fafb' })
    expect(desktopWindowOptions('win32')).toEqual({ backgroundColor: '#f9fafb' })
  })

  it('accepts a platform-adjusted wide resize without accepting the narrow minimum', () => {
    const requested = { width: 1280, height: 840 }
    const minimum = { width: 900, height: 640 }

    expect(isRequestedWindowSizeSettled(
      { width: 1280, height: 684 }, requested, minimum.height,
    )).toBe(true)
    expect(isRequestedWindowSizeSettled(
      { width: 900, height: 640 }, requested, minimum.height,
    )).toBe(false)
    expect(isRequestedWindowSizeSettled(
      { width: 1280, height: 639 }, requested, minimum.height,
    )).toBe(false)
  })

  it('derives renderer appearance from native state', () => {
    expect(rendererSurfaceState(true, false, 'darwin')).toEqual({
      appearance: 'dark', transparency: 'glass', platform: 'darwin', fullscreen: false, focused: true,
    })
    expect(rendererSurfaceState(false, true, 'darwin')).toEqual({
      appearance: 'light', transparency: 'opaque', platform: 'darwin', fullscreen: false, focused: true,
    })
    expect(rendererSurfaceState(true, false, 'linux')).toEqual({
      appearance: 'dark', transparency: 'opaque', platform: 'linux', fullscreen: false, focused: true,
    })
    expect(rendererSurfaceState(false, false, 'darwin', true, false)).toEqual({
      appearance: 'light', transparency: 'glass', platform: 'darwin', fullscreen: true, focused: false,
    })
  })

  it('accepts only native theme preferences', () => {
    expect(parseRendererThemePreference('light')).toBe('light')
    expect(parseRendererThemePreference('dark')).toBe('dark')
    expect(parseRendererThemePreference('system')).toBe('system')
    expect(parseRendererThemePreference('auto')).toBeUndefined()
    expect(parseRendererThemePreference({ theme: 'dark' })).toBeUndefined()
  })

  it('exposes a narrow validated theme bridge over a fixed IPC channel', () => {
    const exposed = new Map<string, unknown>()
    const sent: Array<{ channel: string; value: unknown }> = []
    const listeners = new Map<string, (event: unknown, value: unknown) => void>()
    const contextBridge: NativeThemeContextBridgeLike = {
      exposeInMainWorld(name, value) { exposed.set(name, value) },
    }
    const ipcRenderer: NativeThemeIpcRendererLike = {
      send(channel, value) { sent.push({ channel, value }) },
      sendSync(channel) {
        expect(channel).toBe('dsh:get-native-window-state')
        return {
          appearance: 'light', transparency: 'glass', platform: 'darwin', fullscreen: false, focused: true,
        }
      },
      on(channel, listener) { listeners.set(channel, listener); return this },
      off(channel, listener) {
        if (listeners.get(channel) === listener) listeners.delete(channel)
        return this
      },
    }

    const installed = createNativeThemePreload(contextBridge, ipcRenderer)
    expect([...exposed.keys()]).toEqual(['dshNativeTheme'])
    expect(Object.keys(installed.bridge)).toEqual(['getState', 'setPreference', 'onState'])
    expect(installed.bridge.getState()).toEqual({
      appearance: 'light', transparency: 'glass', platform: 'darwin', fullscreen: false, focused: true,
    })
    installed.bridge.setPreference('dark')
    expect(sent).toEqual([{ channel: 'dsh:set-theme-preference', value: 'dark' }])
    expect(() => { installed.bridge.setPreference('auto' as 'dark') }).toThrow('invalid native theme preference')
    expect(sent).toHaveLength(1)

    const states: unknown[] = []
    const unsubscribe = installed.bridge.onState(state => { states.push(state) })
    listeners.get('dsh:native-window-state')?.({}, {
      appearance: 'dark', transparency: 'opaque', platform: 'darwin', fullscreen: true, focused: false,
    })
    listeners.get('dsh:native-window-state')?.({}, { appearance: 'dark' })
    expect(states).toEqual([{
      appearance: 'dark', transparency: 'opaque', platform: 'darwin', fullscreen: true, focused: false,
    }])

    unsubscribe()
    installed.dispose()
    expect(listeners.size).toBe(0)
    expect(() => { installed.bridge.getState() }).toThrow('native theme preload bridge is disposed')
  })

  it('publishes native changes, validates the sender and payload, and disposes every listener', () => {
    class FakeNativeTheme extends FakeEmitter implements NativeThemeHostLike {
      shouldUseDarkColors = false
      prefersReducedTransparency = false
      themeSource: 'light' | 'dark' | 'system' = 'system'
    }
    class FakeWindow extends FakeEmitter implements NativeWindowHostLike {
      destroyed = false
      fullscreen = false
      focused = true
      readonly sent: Array<{ channel: string; value: unknown }> = []
      readonly webContents = {
        send: (channel: string, value: unknown): void => { this.sent.push({ channel, value }) },
      }
      isDestroyed(): boolean { return this.destroyed }
      isFullScreen(): boolean { return this.fullscreen }
      isFocused(): boolean { return this.focused }
    }
    const ipc = new FakeEmitter() as NativeThemeIpcMainLike & FakeEmitter
    const theme = new FakeNativeTheme()
    const window = new FakeWindow()
    const dispose = installNativeThemeHost({
      ipcMain: ipc,
      nativeTheme: theme,
      window,
      platform: 'darwin',
      eventIsTrusted: event => (event as { trusted?: unknown }).trusted === true,
    })

    const untrustedStateEvent: { trusted: boolean; returnValue?: unknown } = { trusted: false }
    ipc.emit('dsh:get-native-window-state', untrustedStateEvent)
    expect(untrustedStateEvent.returnValue).toBeUndefined()
    const stateEvent: { trusted: boolean; returnValue?: unknown } = { trusted: true }
    ipc.emit('dsh:get-native-window-state', stateEvent)
    expect(stateEvent.returnValue).toEqual({
      appearance: 'light', transparency: 'glass', platform: 'darwin', fullscreen: false, focused: true,
    })

    ipc.emit('dsh:set-theme-preference', { trusted: false }, 'dark')
    ipc.emit('dsh:set-theme-preference', { trusted: true }, 'auto')
    expect(theme.themeSource).toBe('system')
    ipc.emit('dsh:set-theme-preference', { trusted: true }, 'dark')
    expect(theme.themeSource).toBe('dark')

    theme.shouldUseDarkColors = true
    theme.emit('updated')
    window.fullscreen = true
    window.emit('enter-full-screen')
    window.focused = false
    window.emit('blur')
    expect(window.sent.at(-1)).toEqual({
      channel: 'dsh:native-window-state',
      value: {
        appearance: 'dark', transparency: 'glass', platform: 'darwin', fullscreen: true, focused: false,
      },
    })

    const sentBeforeDispose = window.sent.length
    dispose()
    theme.emit('updated')
    window.emit('focus')
    ipc.emit('dsh:set-theme-preference', { trusted: true }, 'light')
    expect(window.sent).toHaveLength(sentBeforeDispose)
    expect(theme.themeSource).toBe('dark')
    expect(theme.listenerCount() + window.listenerCount() + ipc.listenerCount()).toBe(0)
  })
})
