/**
 * Sidebar shell: column geometry only. Collapse is a slide plus crossfade:
 * content freezes at its expanded width (inline style) and fades out in place
 * while the sliding column (AppFrame grid tracks) clips it — nothing reflows
 * mid-slide. The column resolves to a zero-width track (issue #33): at the
 * 150ms settle the shell unmounts, and the frame's own reveal control
 * (outside this subtree) takes over. The workspace/session browsing region
 * between the New Session button and the foot is the `sidebar.workspaces`
 * registrant's, and the foot holds `sidebar.settings` plus
 * `sidebar.footer.action`; these seats render only while the shell is mounted,
 * so they need no collapse-state owner props.
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  BrandWordmark,
  IconNewChatOutline16, IconPanelLeftOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree, or nothing once a collapse settles.
 */
export function SidebarRoot({
  collapsed,
  width,
  startSession,
  toggleSidebar,
  t,
  renderSlot,
}: SidebarRootComponentProps) {
  // Wide content stays mounted while the collapse animates (fading via
  // .fading) and unmounts at settle; the zero-width track then
  // carries nothing until expand remounts it. A cold collapsed render
  // (narrow auto-collapse at boot) skips the fade entirely.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. ui-settings renders its full-viewport panel as a
  // fixed-position DESCENDANT of this column, so a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      /* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  if (!wide) return null

  return (
    <div
      ref={column}
      className={clsx(
        css.root, collapsed && css.fading, !pointerInside && css.quietBars,
      )}
      style={{ width: collapsed ? lastWideWidth.current : width }}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      <div className={css.logoRow} data-sidebar-control-row="">
        {/* Default shell (Web and non-macOS desktop): the wordmark shares
            this first row and the toggle sits at its right edge. The macOS
            desktop CSS hides the inline wordmark (data-sidebar-brand-inline)
            and reveals the brand row below, so the toggle can sit beside the
            native traffic lights. */}
        <button
          type="button"
          className={clsx(css.brand, css.wide)}
          data-sidebar-brand-inline=""
          aria-label={t('session.new.label')}
          onClick={() => { startSession() }}
        >
          <BrandWordmark />
        </button>
        {/* Expanded, the toggle carries its own label — the collapsed
            affordance belongs to the frame's reveal control (AppFrame),
            which sits outside this zero-width subtree. */}
        <Tooltip label={t('toggle.collapse')} delayMs={500}>
          <button
            type="button"
            className={clsx(css.iconButton, css.toggle)}
            data-sidebar-toggle=""
            aria-label={t('toggle.collapse')}
            onClick={() => { toggleSidebar() }}
          >
            <IconPanelLeftOutline16 className={css.panelIcon} size={16} />
          </button>
        </Tooltip>
      </div>

      <div className={css.brandRow} data-sidebar-brand-row="">
        {/* Compact macOS header: hidden by default; the desktop shell
            reveals it under body[data-dsh-platform='darwin']. */}
        <button
          type="button"
          className={clsx(css.brand, css.wide)}
          aria-label={t('session.new.label')}
          onClick={() => { startSession() }}
        >
          <BrandWordmark />
        </button>
      </div>

      <button
        type="button"
        className={css.newSession}
        aria-label={t('session.new.label')}
        onClick={() => { startSession() }}
      >
        <IconNewChatOutline16 size={14} />
        <span className={clsx(css.newSessionLabel, css.wide)}>{t('session.new')}</span>
      </button>

      {/* The browsing region fills the column between the controls and the
          foot; it rides the same slot in the wide state only (the collapsed
          shell unmounts entirely). */}
      <div className={css.regionArea}>
        {renderSlot('sidebar.workspaces', {})}
      </div>

      {/* Footer actions stack above Settings in the mounted expanded shell. */}
      <div className={css.footArea}>
        <div className={css.footerActions}>
          {renderSlot('sidebar.footer.action', {})}
        </div>
        <div className={css.settingsArea}>
          {renderSlot('sidebar.settings', {})}
        </div>
      </div>
    </div>
  )
}
