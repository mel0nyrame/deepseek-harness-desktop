# Agent Note: Desktop window acceptance baselines the OS-granted bounds

Status: implemented

English | [中文](2026-08-16-desktop-window-granted-bounds-baseline.zh.md)

## Problem

The keyless packaged-app smoke failed on the arm64 lane of the Desktop release matrix (macos-26) while the same assertions passed on x64. Both window-journey tests assert the recorded window bounds are unchanged across the synthetic drag attempt and later interactions, but the evidence line compared window.getBounds() against the requested rect { x: 120, y: 120, width: 960, height: 700 } stored as initialBounds. macOS constrains setBounds to the display's work area: the arm64 runner's work area is 677px tall (y 31..708), so the requested 700px window at y=120 cannot fit and the OS grants { x: 120, y: 31, width: 960, height: 677 } — requested versus granted, not a window that moved. The x64 runner's taller work area grants the request verbatim, which is why that lane stayed green.

## Decision

- In acceptNativeWindow and recordNativeWindow (apps/desktop/src/main.ts), initialBounds is read from window.getBounds() immediately before the synthetic drag input — the bounds macOS granted after show — instead of the requested literal. The request rect is still applied through setBounds, but the evidence baseline is granted reality.
- The packaged-smoke assertions compare draggedBounds / dragAttemptBounds / controlBounds against that granted baseline, so the product claim stays "synthetic drag input cannot move the native window" and holds on any work-area height.
- The journey itself is owned by the [interaction-parity scenario note](../testing/2026-08-16-desktop-interaction-parity-scenario.md); this note only changes what the window-bounds evidence field means: initialBounds now reports the position the OS granted at drag start, not the position the recording requested.

## Alternatives considered

**Request a rect that fits today's arm64 runner (e.g. 640px tall at a lower y).** Rejected: it unblocks this runner but keeps the recording fragile against any shorter display; the granted baseline is display-independent.

**Compare only width and x, skipping y and height.** Rejected: it weakens the no-move claim exactly where the platform can legitimately differ.

**Clamp the application window to the work area before setBounds.** Rejected: that changes product behavior for a test-only concern — users can still request larger or restored windows, and OS clamping is the platform contract the recording should observe, not override.

## Consequences

- The packaged smoke passes on both runner classes regardless of work-area height; on displays tall enough, the granted rect equals the requested rect, preserving the previous strictness.
- The evidence field name initialBounds is unchanged, but its contract is now "granted at drag start"; the test comment and the two recording call sites document the clamping contract so the next debugger does not re-derive it from the CI diff.
