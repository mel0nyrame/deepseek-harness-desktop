# Agent Note: Compact macOS desktop window presentation

Status: implemented

English | [中文](2026-08-16-macos-compact-window-presentation.zh.md)

## Problem

The macOS desktop window reserved a full-width 44-pixel title strip above the sidebar and conversation, and a collapsed sidebar kept a fixed rail. That separated the conversation from the window top, kept native controls out of the product frame, and wasted horizontal space after collapse. The sidebar also needed a durable material preference whose visible result could follow macOS accessibility settings.

## Decision

The compact native window frame is implemented by the [macOS native window foundation note](2026-08-17-macos-compact-window-foundation.md), which owns Issue #32. This note owns the completed Issue #33 zero-width sidebar presentation and Issue #34 sidebar material preference.

On macOS, the sidebar's first row shares the native traffic-light region with the sidebar control, the wordmark occupies the following row, and the conversation surface reaches the window top. The actual topmost conversation header, sidebar control and wordmark rows, and modal title rows are drag regions; controls, conversation content, the composer, and modal bodies remain interactive no-drag regions. A collapsed sidebar resolves to a zero-width grid track; its material, contents, resize handle, and divider disappear, while a frame-owned reveal control restores the last usable width. Native full screen leaves traffic-light visibility to AppKit and moves the reveal control to the sidebar content inset.

The expanded sidebar uses one continuous native translucent material, while conversation and details remain opaque. Both glass variants expose that material directly; the [native light sidebar material note](../bug-fix/2026-08-18-native-light-sidebar-material.md) owns how the application preference selects the matching AppKit appearance. General → Appearance renders the macOS-only `Sidebar glass effect` switch from the `ui-sidebar-glass-macos.enabled` Host setting. The default is enabled, writes apply immediately, and the value survives restart. Reduce Transparency selects the theme-matched opaque material without rewriting the saved preference; restoring transparency therefore reveals glass again when the preference remains enabled. The desktop bundle inserts the Host contribution only when `process.platform === 'darwin'`, so Web, Windows, and Linux do not register or display this control.

## Alternatives considered

**Keep the full-width synthetic title strip.** Rejected because it prevents the conversation from reaching the window top and reserves renderer space outside the native control cluster.

**Retain a compact collapsed-sidebar rail.** Rejected because it keeps consuming width after collapse. A frame-owned reveal control preserves access without retaining the sidebar track.

**Create a separate Appearance page.** Rejected because General → Appearance already owns theme preferences and is the existing platform-aware settings surface.

**Persist the glass state in renderer storage.** Rejected because the preference is global and must survive restart. Host-backed settings provide the durable boundary and allow Reduce Transparency to override only the visible material.

**Override Electron's global native theme from the renderer preference.** This original choice is superseded by the [native light sidebar material note](../bug-fix/2026-08-18-native-light-sidebar-material.md): a local tint cannot turn a dark AppKit substrate into native light material, so matching OS-rendered chrome and Electron UI to the explicit application preference is now intentional.

**Register the preference in every composition.** Rejected because the native material and macOS accessibility fact do not exist on Web, Windows, or Linux. The dedicated macOS Host contribution keeps the platform boundary explicit.

## Consequences

- `AppFrame` exposes stable frame, sidebar, conversation, and details surface hooks for desktop CSS without coupling the shell to CSS-module class names.
- The desktop renderer publishes platform, theme, and Reduce Transparency facts; the sidebar runtime owns immediate projection and Host-backed persistence, while system facts never write the saved preference. The control is available only when the macOS namespace is both present and writable.
- `@deepseek-ai/dsh-client-ui-theme/sidebar-glass` is a Host-only export with a hard settings dependency. `cordis.patch.yml` inserts it only on macOS, and ApiProxy exposes the namespace to the desktop renderer.
- The macOS desktop CSS keeps the sidebar descendants transparent so hover, selection, and focus remain overlays on the one native material; opaque light and dark fallbacks use explicit neutral surfaces.
- Focused client, Host-composition, policy, and packaged tests cover default-on behavior, immediate toggling, restart persistence, theme changes, Reduce Transparency override, zero-width collapse, and non-macOS isolation. The packaged acceptance journey uses one explicit test home across its three phases.
