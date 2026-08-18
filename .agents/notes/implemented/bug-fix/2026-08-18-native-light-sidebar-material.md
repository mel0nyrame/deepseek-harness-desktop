# Agent Note: Native light sidebar material follows the application theme

Status: implemented

English | [中文](2026-08-18-native-light-sidebar-material.zh.md)

## Problem

The macOS glass sidebar left its renderer surface transparent over Electron's AppKit-backed window material. When the application preference was explicitly Light but macOS was Dark, Electron's native theme remained `system`, so the substrate stayed dark. Adding a translucent white renderer tint changed the pixels but did not create native light material: higher opacity hid the blur, while lower opacity revealed more of the dark substrate.

## Decision

The application theme preference is mirrored across a dedicated context-isolated preload bridge into validated main-process IPC. Electron main assigns the accepted `light`, `dark`, or `system` value to `nativeTheme.themeSource`; it never accepts another wire value. The theme plugin sends the persisted preference, not the resolved color scheme, and suppresses duplicate sends so `system` retains OS-following semantics and native appearance updates do not create a feedback loop.

Both `glass-light` and `glass-dark` leave the sidebar surface transparent over the existing `under-window` vibrancy. AppKit therefore supplies the light or dark native material selected by `nativeTheme`, while the dark material configuration remains unchanged. Reduce Transparency continues to select the explicit opaque fallback without changing the saved glass or theme preference.

This decision partially supersedes the local light-tint choice in the [compact macOS desktop window presentation note](../feature/2026-08-16-macos-compact-window-presentation.md); that note still owns the compact chrome, zero-width collapse, material preference, and platform boundary.

## Alternatives considered

**Tune a translucent light CSS fill.** Rejected because opacity trades blur visibility against darkness without changing the AppKit material's appearance.

**Change the macOS vibrancy material.** Rejected because the existing dark `under-window` result is correct and the defect follows the native appearance, not the material type.

**Send only the resolved light or dark color scheme.** Rejected because it would erase the user's `system` choice and could bounce OS-driven appearance changes back into an application override.

**Read Host theme settings directly in Electron main.** Rejected because the renderer theme runtime already owns preference adoption and change events; a second settings consumer would duplicate synchronization and lifecycle behavior.

## Consequences

- Explicit Light and Dark preferences now affect macOS-rendered window chrome and Electron UI as well as the renderer palette; System removes that override and follows macOS.
- The sidebar keeps one transparent native-material path in both palettes, so no renderer fill can darken or flatten the light glass.
- Focused tests cover preload forwarding, IPC validation, preference deduplication, and transparent glass CSS. The installed three-launch journey also reads `nativeTheme.themeSource` from Electron main and pins Dark, Light, System, persistence, and Reduce Transparency behavior. When macOS starts the journey with Reduce Transparency enabled, the acceptance first verifies the opaque fallback and visible override notice, then restores transparency only in the acceptance window so the same run still exercises native glass. Before closing the window, it waits for the final Light selection to reach the Host settings document so the reopen launch does not race the asynchronous settings write.
