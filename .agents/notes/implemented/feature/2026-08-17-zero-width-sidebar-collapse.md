# Agent Note: Zero-width sidebar collapse

Status: implemented

English | [中文](2026-08-17-zero-width-sidebar-collapse.zh.md)

## Problem

The zero-width collapse is the sidebar half of the approved [compact macOS window presentation](../../proposed/feature/2026-08-16-macos-compact-window-presentation.md) (Issues #32–#34). Collapsing the sidebar left a fixed 56px compact rail: the sidebar material, contents, resize handle, and divider stayed on screen, the conversation only recovered the rail's width, and the collapse toggle lived inside the rail itself. The compact macOS frame (Issue #32) also made the rail's geometry conflict with the native traffic-light row — the rail had its own collapsed geometry and the toggle could not share the light group's position while collapsed.

## Decision

A collapsed sidebar resolves to a zero-width layout track (Issue #33). The concession solver returns 0 for a closed sidebar, the sidebar subtree unmounts at the 150ms crossfade settle, the column's divider is dropped, and the resize handle is not rendered — no fixed compact rail remains. The collapse reveal control is owned by the layout frame (AppFrame) and rendered as a frame child OUTSIDE the zero-width sidebar subtree (`data-sidebar-reveal`), so it stays visible and interactive in every collapsed state, including narrow-viewport auto-collapse. On macOS the desktop shell positions it beside the native traffic lights in windowed mode (left 84px, matching the expanded toggle's left edge) and at the sidebar's left content inset in native full screen (left 12px) via `DESKTOP_SURFACE_CSS`. The conversation header clears only that top-left chrome cluster (120px windowed, 48px full screen), keeps its title aligned with the reveal control with a shared 1.2px vertical offset, and carries the Chat / Trajectory row and divider with it — it never retains the former sidebar width. Expanding restores the last usable sidebar width: the layout store keeps `sidebarLast`, drag writes refresh it, and the manual toggle closes to 0 and reopens to that width instead of the contract default; narrow auto-collapse keeps its existing preference semantics (preference untouched, `narrowExpanded` override).

## Alternatives considered

- **Keep the 56px compact rail.** Rejected: the rail is exactly what the issue removes — collapsed still occupies a fixed strip, and its toggle cannot sit in the native traffic-light row.
- **Render the reveal control inside the sidebar subtree (the old rail toggle).** Rejected: a zero-width subtree has no room for an interactive affordance; the control must live outside it (AC #3).
- **Reopen to the contract default width.** Rejected: restoring the last usable width is the issue's explicit requirement (AC #7), and the store already had the drag width before the close.

## Consequences

- `columns.ts` no longer exports `SIDEBAR_COLLAPSED`; closed sidebar resolves to 0 and the center column absorbs the reclaimed width.
- The layout store adds `sidebarLast` (last usable width); `toggleSidebar` (wide) closes to 0 remembering it and reopens to it; `setSidebar` refreshes it on every open write.
- `AppFrame` renders `data-sidebar-reveal` (owned chrome, ui-layout locale namespace `layout`), removes the sidebar drag handle while collapsed, and drops the collapsed column's divider border.
- `SidebarRoot` renders nothing once the collapse settles (fade-only collapse, no rail); the expanded toggle stays in the sidebar's first row.
- The conversation header exposes the `data-conversation-header` attribute hook; client CSS clears the reveal control (48px) and `DESKTOP_SURFACE_CSS` aligns the collapsed title row while adding macOS traffic-light cluster clearance (120px windowed, 48px full screen) and a shared 1.2px vertical offset.
- `DESKTOP_SURFACE_CSS` drops the collapsed-rail rule and adds `[data-sidebar-reveal]` positioning (84px windowed, 12px full screen) plus the header alignment and clearance rules.
- Packaged acceptance (`--accept-native-window`) now drags the sidebar, collapses it, and asserts the zero-width track, reclaimed conversation width, reveal position in both window states, header clearance, and the restored dragged width; `--record-native-window` also captures `session-sidebar-collapsed` and `session-fullscreen-collapsed` after a keyless turn settles so the title, tabs, and divider are visible.
- The browsing ownership boundary from [Session List Browsing and Manual Workspace Order](2026-07-25-session-list-browsing-and-manual-order.md) remains: sidebar child seats carry no collapse-state owner props, and the workspace browser, Settings, and footer actions render only their expanded forms while the shell is mounted.
