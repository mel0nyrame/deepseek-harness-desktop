# Agent Note: Compact macOS native window frame

Status: implemented

English | [中文](2026-08-17-macos-compact-window-foundation.zh.md)

## Problem

The desktop renderer previously injected a synthetic full-width 44-pixel title strip and offset the client root below it. That made the app feel like a web client under a fake title bar, prevented the conversation from reaching the window top, and kept the sidebar toggle at the right edge instead of sharing the native traffic-light row.

## Decision

The desktop uses the approved A — Compact macOS frame as the platform-aware window foundation (Issue #32). macOS keeps `hiddenInset` native traffic lights and uses the native window surface as the drag region; the sidebar's first row holds the sidebar toggle to the right of the native light group with intentional spacing, and the DeepSeek Harness wordmark occupies the following row. The renderer no longer uses a synthetic full-width strip or global top inset. The compact header is a macOS-only presentation: `DESKTOP_SURFACE_CSS` applies it under `body[data-dsh-platform='darwin']`, while Web, Windows, and Linux keep the previous sidebar shell and receive only the existing `desktopWindowOptions` extension boundary, with no placeholder chrome. In native full screen AppKit owns traffic-light auto-hide and screen-top hover reveal; the application only uses `data-dsh-fullscreen` to move the sidebar control and wordmark rows to the sidebar's left content inset.

## Alternatives considered

- **Keep the 44-pixel synthetic title strip.** Rejected because it separates the conversation from the window top and prevents the sidebar toggle from sharing the native traffic-light row.
- **Draw renderer-side macOS-like window controls on Windows and Linux.** Rejected because no non-macOS design is approved; the platform boundary remains an explicit extension point without placeholder chrome.

## Consequences

- `DESKTOP_SURFACE_CSS` now scopes drag/no-drag rules to `body[data-dsh-platform='darwin']` and keeps interactive shell regions no-drag.
- `RendererSurfaceState` includes `platform` so renderer boot facts carry the platform boundary.
- The sidebar shell keeps the wordmark in the first row by default and exposes hidden `data-sidebar-control-row` / `data-sidebar-brand-row` / `data-sidebar-brand-inline` seams; the macOS desktop CSS switches the header to the compact control and wordmark rows.
- The windowed control row clears the native traffic-light group with an intentional gap (`MACOS_CONTROL_ROW_INSET_PX`); full screen returns both rows to the sidebar's left content inset without forcing native window-button visibility.
- Packaged acceptance now asserts root top 0 and full content height instead of the 44-pixel strip.
