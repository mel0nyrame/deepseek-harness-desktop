# Agent Note: Compact macOS desktop window presentation

Status: proposed

English | [中文](2026-08-16-macos-compact-window-presentation.zh.md)

## Problem

The current macOS desktop window reserves a full-width 44-pixel title strip above both the sidebar and conversation. That web-drawn band separates the conversation from the window top and prevents the sidebar controls from sharing a compact native-control region. Its collapsed sidebar also leaves a fixed rail, wasting horizontal space after the sidebar has been hidden.

The window needs an explicit macOS presentation that preserves native traffic lights and macOS accessibility behavior while making the conversation feel like it reaches the top of the application. The sidebar needs one material boundary, and the material must be controlled by a durable user setting rather than a renderer-only visual state.

## Proposal

### Scope and ownership

This proposal owns the macOS presentation of the Electron desktop application. It refines the window baseline from the [Electron desktop application proposal](2026-08-14-electron-desktop-app.md) and is the decision owner for [Issue #32](https://github.com/mel0nyrame/deepseek-harness-desktop/issues/32), [Issue #33](https://github.com/mel0nyrame/deepseek-harness-desktop/issues/33), and [Issue #34](https://github.com/mel0nyrame/deepseek-harness-desktop/issues/34). The 44-pixel title strip is the existing baseline, not the proposed presentation.

macOS is the first implementation. Windows and Linux retain explicit platform presentation extension points, but receive neither placeholder controls nor an imitation of the macOS chrome.

### Compact window frame

Use the native macOS traffic lights in the first compact sidebar row. Place the sidebar-collapse control immediately to their right. Keep the DeepSeek Harness wordmark in the following sidebar row, and raise the sidebar and conversation header content into the compact frame. The traffic-light and control row reserves the top-left native-control space only; the opaque conversation surface extends to the top edge of the window, and its title row remains approximately aligned with that row.

Remove the synthetic full-width title strip and its global renderer top inset. Empty chrome regions drag the native window. Traffic lights, the sidebar control, tabs, Session log, editable elements, and overlays remain interactive no-drag regions.

The Chat / Trajectory active indicator overlays the conversation-header divider so the blue underline and divider share one boundary without a visible gap.

### Zero-width sidebar

Collapsing the sidebar resolves its layout track to zero width. Sidebar material, contents, resize handle, and vertical divider disappear together. A reveal control outside the zero-width sidebar remains visible and restores the last usable sidebar width; it does not reserve a permanent compact rail.

In a windowed macOS application, the reveal control coexists with the native traffic lights in the top-left control region. In native full screen, the traffic lights disappear and the reveal control aligns to the left content inset without vertically reflowing the remaining sidebar content. Manual collapse and narrow-viewport auto-collapse share the zero-width rendered result while retaining their existing preference semantics.

### Sidebar glass preference

The expanded macOS sidebar uses one continuous supported native translucent material behind its native-control, brand, workspace, session, and Settings regions. New Session and selected-session treatments remain readable overlays on that material. The conversation surface remains opaque.

The existing General → Appearance surface owns a macOS-only `Sidebar glass effect` switch below the theme preference. It defaults to enabled, applies immediately, and persists globally through Host-backed settings. It does not appear on Windows or Linux.

Reduce Transparency forces the theme-appropriate opaque sidebar fallback without changing the saved preference. The setting explains that macOS is overriding the visible effect while the override is active. Light and dark appearance preserve legible text, icons, borders, and keyboard focus in either effective material.

### Verification

Window-policy tests cover macOS options, traffic-light placement, material prerequisites, and non-macOS isolation. Client shell tests cover visible header, drag-region, interaction, collapse, width restoration, and full-screen relationships without depending on incidental DOM structure. Settings tests cover the default, write, invalidation/reload convergence, and preservation of the preference while the system override is active.

A keyless real packaged-macOS journey records the compact window, native controls, drag behavior, collapse and reveal, restored width, full-screen alignment, immediate material changes, restart persistence, and the Reduce Transparency fallback. Native window state is asserted separately from visual evidence.

## Alternatives considered

**Keep the full-width synthetic title strip.** Rejected because it pushes both product columns below a renderer-drawn band and prevents the conversation surface from reaching the window top while reserving native control space only where it is needed.

**Retain a compact collapsed-sidebar rail.** Rejected because it consumes horizontal space after collapse. A reveal control outside a zero-width sidebar preserves access without keeping the sidebar layout track alive.

**Create a separate Appearance settings page.** Rejected because the existing General → Appearance surface already owns appearance preferences; a second location would divide related controls without adding a platform boundary.

**Persist glass state in renderer storage.** Rejected because the preference is global and must survive application restart. Host-backed settings already own durable user preferences and let system accessibility override the effective material without rewriting user intent.

**Ship macOS-like window controls on Windows and Linux now.** Rejected because no platform design is approved for those systems. Explicit extension points preserve their implementation path without presenting a non-native placeholder.

## Acceptance criteria

- The renderer no longer uses a synthetic full-width 44-pixel title strip or an equivalent global top inset.
- macOS uses real system traffic lights in the compact first sidebar row, with the sidebar-collapse control immediately to their right and the wordmark in the following row.
- The opaque conversation surface reaches the top edge; its title aligns with the native-control row; and the Chat / Trajectory active indicator shares the conversation-header divider without a visible gap.
- Empty chrome regions drag the window while every interactive control remains a no-drag region.
- Collapse removes the entire sidebar layout track, material, contents, resize handle, and divider; reveal restores the last usable width without retaining a compact rail.
- Native full screen hides the traffic lights and left-aligns the reveal control without vertically reflowing remaining sidebar content.
- The expanded macOS sidebar has one continuous supported native translucent material while the conversation remains opaque.
- General → Appearance exposes the default-enabled `Sidebar glass effect` switch only on macOS; it applies immediately and persists globally through restart.
- Reduce Transparency forces the opaque fallback without rewriting the saved preference, and all effective appearance combinations remain readable and keyboard accessible.
- Windows and Linux retain an explicit implementation boundary but no speculative platform chrome or non-functional setting.
- Focused policy, client-shell, and settings tests plus a keyless packaged-macOS GUI journey cover the stated behavior; English and Chinese documentation, localization artifacts, and documentation gates remain synchronized.

## Risks

Native traffic-light placement, vibrancy, and full-screen behavior vary with macOS versions and accessibility settings. The product therefore tests native window state separately from screenshot evidence and retains the opaque fallback.

The zero-width layout changes header geometry, resize behavior, and responsive collapse. Shared rendered-state assertions and a packaged journey prevent a compact rail or a stale width reservation from reappearing through either path.

The glass preference crosses renderer, Host-backed settings, and platform facts. Its effective-material rule must keep the user preference durable while allowing Reduce Transparency to override its visible result.
