import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** Renderer-originated unary request after preload validation. */
export interface DesktopChildRequest {
  readonly type: 'request'
  readonly id: string
  readonly url: string
  readonly method: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body?: string
}

/** Electron-main command sent to the dedicated DSH child. */
export type DesktopParentMessage =
  | DesktopChildRequest
  | { readonly type: 'cancel-request'; readonly id: string }
  | { readonly type: 'subscribe'; readonly id: string; readonly stream: 'mux' | 'host' }
  | { readonly type: 'cancel-subscription'; readonly id: string }

/** Built client artifact paired with one manifest row. */
export interface DesktopClientBundle {
  readonly id: string
  readonly path: string
}

/** Dedicated DSH child notification consumed by Electron main. */
export type DesktopChildMessage =
  | { readonly type: 'ready'; readonly graph: WebBootGraph; readonly bundles: readonly DesktopClientBundle[] }
  | {
    readonly type: 'response'
    readonly id: string
    readonly status: number
    readonly headers: readonly (readonly [string, string])[]
    readonly body: string
  }
  | { readonly type: 'request-error'; readonly id: string; readonly message: string }
  | { readonly type: 'stream-open'; readonly id: string }
  | { readonly type: 'stream-message'; readonly id: string; readonly message: unknown }
  | { readonly type: 'stream-error'; readonly id: string; readonly message: string }
  | { readonly type: 'stream-end'; readonly id: string }
