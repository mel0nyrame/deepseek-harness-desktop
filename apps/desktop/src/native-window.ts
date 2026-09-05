/** Native window policy and the renderer's narrow theme-preference bridge. */

export type RendererThemePreference = 'light' | 'dark' | 'system'

export interface NativeWindowOptions {
  readonly width?: number
  readonly height?: number
  readonly minWidth?: number
  readonly minHeight?: number
  readonly backgroundColor: string
  readonly titleBarStyle?: 'hiddenInset'
  readonly trafficLightPosition?: { readonly x: number; readonly y: number }
  readonly transparent?: boolean
  readonly vibrancy?: 'under-window'
  readonly visualEffectState?: 'followWindow'
}

export interface WindowSizeLike {
  readonly width: number
  readonly height: number
}

export interface RendererSurfaceState {
  readonly appearance: 'light' | 'dark'
  readonly transparency: 'glass' | 'opaque'
  readonly platform: NodeJS.Platform
  readonly fullscreen: boolean
  readonly focused: boolean
}

export interface NativeThemeBridge {
  /** Read the current operating-system appearance and window state. */
  getState(): RendererSurfaceState
  /** Ask Electron to follow a light, dark, or operating-system appearance. */
  setPreference(preference: RendererThemePreference): void
  /** Observe operating-system appearance and window-state updates. */
  onState(listener: (state: RendererSurfaceState) => void): () => void
}

export interface NativeThemeContextBridgeLike {
  exposeInMainWorld(name: string, value: unknown): void
}

export interface NativeThemeIpcRendererLike {
  send(channel: string, value: unknown): void
  sendSync(channel: string): unknown
  on(channel: string, listener: (event: unknown, value: unknown) => void): this
  off(channel: string, listener: (event: unknown, value: unknown) => void): this
}

interface EventEmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): this
  off(event: string, listener: (...args: unknown[]) => void): this
}

export interface WindowMoveEmitterLike {
  on(event: 'move', listener: () => void): unknown
  off(event: 'move', listener: () => void): unknown
}

export interface NativeThemeHostLike extends EventEmitterLike {
  readonly shouldUseDarkColors: boolean
  readonly prefersReducedTransparency: boolean
  themeSource: RendererThemePreference
}

export interface NativeWindowHostLike extends EventEmitterLike {
  readonly webContents: { send(channel: string, value: unknown): void }
  isDestroyed(): boolean
  isFullScreen(): boolean
  isFocused(): boolean
}

export type NativeThemeIpcMainLike = EventEmitterLike

export interface InstallNativeThemeHostOptions {
  readonly ipcMain: NativeThemeIpcMainLike
  readonly nativeTheme: NativeThemeHostLike
  readonly window: NativeWindowHostLike
  readonly platform: NodeJS.Platform
  readonly eventIsTrusted: (event: unknown) => boolean
}

const NATIVE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd',
])

/** Return the host-owned BrowserWindow presentation for one platform. */
export function desktopWindowOptions(platform: NodeJS.Platform): NativeWindowOptions {
  if (platform !== 'darwin') return { backgroundColor: '#f9fafb' }
  return {
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
  }
}

/** Return whether a requested wide size settled with a platform-adjusted frame height. */
export function isRequestedWindowSizeSettled(
  actual: WindowSizeLike,
  requested: WindowSizeLike,
  minimumHeight: number,
): boolean {
  return actual.width === requested.width
    && actual.height >= Math.min(minimumHeight, requested.height)
    && actual.height <= requested.height
}

/** Derive renderer data attributes from validated Electron native state. */
export function rendererSurfaceState(
  shouldUseDarkColors: boolean,
  reduceTransparency: boolean,
  platform: NodeJS.Platform,
  fullscreen = false,
  focused = true,
): RendererSurfaceState {
  return {
    appearance: shouldUseDarkColors ? 'dark' : 'light',
    transparency: platform === 'darwin' && !reduceTransparency ? 'glass' : 'opaque',
    platform,
    fullscreen,
    focused,
  }
}

/** Parse one untrusted native-window state payload before renderer delivery. */
export function parseRendererSurfaceState(value: unknown): RendererSurfaceState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if ((candidate.appearance !== 'light' && candidate.appearance !== 'dark')
    || (candidate.transparency !== 'glass' && candidate.transparency !== 'opaque')
    || typeof candidate.platform !== 'string'
    || !NATIVE_PLATFORMS.has(candidate.platform as NodeJS.Platform)
    || typeof candidate.fullscreen !== 'boolean'
    || typeof candidate.focused !== 'boolean') return undefined
  return {
    appearance: candidate.appearance,
    transparency: candidate.transparency,
    platform: candidate.platform as NodeJS.Platform,
    fullscreen: candidate.fullscreen,
    focused: candidate.focused,
  }
}

/** Parse an untrusted renderer theme-preference IPC payload. */
export function parseRendererThemePreference(value: unknown): RendererThemePreference | undefined {
  if (value === 'light' || value === 'dark' || value === 'system') return value
  return undefined
}

/** Resolve whether a native window moved before the deadline and release both wait branches. */
export function waitForWindowMove(window: WindowMoveEmitterLike, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveMove) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    const finish = (moved: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      window.off('move', onMove)
      resolveMove(moved)
    }
    const onMove = (): void => { finish(true) }
    window.on('move', onMove)
    timeout = setTimeout(() => { finish(false) }, timeoutMs)
  })
}

/** Install the context-isolated renderer bridge used by the UI theme contribution. */
export function createNativeThemePreload(
  contextBridge: NativeThemeContextBridgeLike,
  ipcRenderer: NativeThemeIpcRendererLike,
): { readonly bridge: NativeThemeBridge; dispose(): void } {
  const listeners = new Set<(state: RendererSurfaceState) => void>()
  let disposed = false
  const assertActive = (): void => {
    if (disposed) throw new Error('native theme preload bridge is disposed')
  }
  const onNativeState = (_event: unknown, value: unknown): void => {
    if (disposed) return
    const state = parseRendererSurfaceState(value)
    if (state === undefined) return
    for (const listener of listeners) {
      try {
        listener(state)
      } catch (error) {
        console.error('[desktop-preload] native theme listener threw:', error)
      }
    }
  }
  const bridge: NativeThemeBridge = {
    getState(): RendererSurfaceState {
      assertActive()
      const state = parseRendererSurfaceState(ipcRenderer.sendSync('dsh:get-native-window-state'))
      if (state === undefined) throw new Error('invalid native window state')
      return state
    },
    setPreference(preference): void {
      assertActive()
      const parsed = parseRendererThemePreference(preference)
      if (parsed === undefined) throw new TypeError('invalid native theme preference')
      ipcRenderer.send('dsh:set-theme-preference', parsed)
    },
    onState(listener): () => void {
      assertActive()
      if (typeof listener !== 'function') throw new TypeError('invalid native theme listener')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  ipcRenderer.on('dsh:native-window-state', onNativeState)
  contextBridge.exposeInMainWorld('dshNativeTheme', bridge)
  return {
    bridge,
    dispose(): void {
      if (disposed) return
      disposed = true
      listeners.clear()
      ipcRenderer.off('dsh:native-window-state', onNativeState)
    },
  }
}

/** Connect Electron native appearance and window events to the trusted product renderer. */
export function installNativeThemeHost(options: InstallNativeThemeHostOptions): () => void {
  const { ipcMain, nativeTheme, window, platform, eventIsTrusted } = options
  const snapshot = (): RendererSurfaceState => rendererSurfaceState(
    nativeTheme.shouldUseDarkColors,
    nativeTheme.prefersReducedTransparency,
    platform,
    window.isFullScreen(),
    window.isFocused(),
  )
  const publish = (): void => {
    if (!window.isDestroyed()) window.webContents.send('dsh:native-window-state', snapshot())
  }
  const getState = (...args: unknown[]): void => {
    const event = args[0]
    if (!eventIsTrusted(event) || typeof event !== 'object' || event === null) return
    ;(event as { returnValue?: unknown }).returnValue = snapshot()
  }
  const setPreference = (...args: unknown[]): void => {
    const event = args[0]
    if (!eventIsTrusted(event)) return
    const preference = parseRendererThemePreference(args[1])
    if (preference !== undefined) nativeTheme.themeSource = preference
  }
  const registrations: Array<{
    emitter: EventEmitterLike
    event: string
    listener: (...args: unknown[]) => void
  }> = [
    { emitter: ipcMain, event: 'dsh:get-native-window-state', listener: getState },
    { emitter: ipcMain, event: 'dsh:set-theme-preference', listener: setPreference },
    { emitter: nativeTheme, event: 'updated', listener: publish },
    { emitter: window, event: 'enter-full-screen', listener: publish },
    { emitter: window, event: 'leave-full-screen', listener: publish },
    { emitter: window, event: 'focus', listener: publish },
    { emitter: window, event: 'blur', listener: publish },
  ]
  for (const registration of registrations) {
    registration.emitter.on(registration.event, registration.listener)
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const registration of registrations) {
      registration.emitter.off(registration.event, registration.listener)
    }
  }
}
