/**
 * The native picking occupant (package-internal; the `./client` surface
 * exposes only the Loader exports). Same-package tests exercise it directly
 * through this module.
 */
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
// Type-only: the owner contract of the directory-flow holes.
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Injected face: the wire call the flow drives (bound in apply's closure). */
export interface NativeFlowInjected {
  /** Ask the local Host to open its native single-directory chooser. */
  pick: (signal: AbortSignal) => Promise<string | null>
}

/**
 * Renderless flow occupant: each rising `open` edge runs exactly one pick and
 * reports exactly one outcome; the ref arms once per open so re-renders (and
 * an adoption keeping `open` true while `busy`) never launch a second
 * chooser. The owner withdrawing `open` re-arms the next request.
 * @param props - owner conversation plus the injected pick call.
 * @returns nothing — the native chooser renders on the host display.
 */
export function NativeDirectoryFlow(props: DirectoryFlowOwnerProps & NativeFlowInjected): ReactElement | null {
  const { open, pick } = props
  const armed = useRef(false)
  const active = useRef<AbortController>()
  const currentPick = useRef(pick)
  currentPick.current = pick
  // Callbacks ride a ref so the settled pick reports through the owner's
  // latest handlers, not the ones captured when the chooser opened.
  const outcome = useRef(props)
  outcome.current = props
  // Unmount or owner withdrawal aborts the wire request and discards its
  // settlement wholesale. An injected-face identity change alone keeps the
  // pending operation: the chooser on the host display is still the same task.
  const alive = useRef(true)
  useEffect(() => {
    // StrictMode's development replay runs the cleanup once before the real
    // lifetime: re-arm on setup or every outcome would be discarded.
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (!open) {
      armed.current = false
      active.current?.abort()
      active.current = undefined
      return
    }
    if (!armed.current) {
      armed.current = true
      const controller = new AbortController()
      active.current = controller
      currentPick.current(controller.signal).then(
        (path) => {
          if (!alive.current || controller.signal.aborted) return
          if (path === null) outcome.current.onCancel(); else outcome.current.onPicked(path)
        },
        (reason: unknown) => {
          if (!alive.current || controller.signal.aborted) return
          outcome.current.onError(reason instanceof Error ? reason.message : String(reason))
        },
      )
    }
    const controller = active.current
    return () => {
      // StrictMode immediately restores the same lifetime after its probe
      // cleanup. Defer physical cancellation so that replay retains one dialog;
      // a real unmount leaves `alive` false and aborts before the next task.
      queueMicrotask(() => {
        if (alive.current || active.current !== controller) return
        armed.current = false
        active.current = undefined
        controller?.abort()
      })
    }
  }, [open])
  return null
}
