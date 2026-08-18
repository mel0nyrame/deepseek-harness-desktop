# Agent Note: macOS native window drag acceptance

Status: implemented

English | [中文](2026-08-18-macos-native-window-drag-acceptance.zh.md)

## Problem

A declared or computed `app-region: drag` value does not prove that AppKit can move a native window. Renderer content may cover the declared region, and Electron synthetic input does not traverse the operating-system pointer path that performs native dragging. The compact window therefore needs evidence that distinguishes renderer styling from an observable native move without turning every test host's Accessibility permission into an implicit requirement.

## Decision

Static tests pin the ownership boundary: the `body` is not a drag region, actual topmost compact chrome owns drag behavior, and interactive content owns no-drag behavior. Standard modal headers and the headless onboarding title publish the semantic `data-window-drag-surface` hook so desktop CSS can extend the same contract to overlays without coupling to generated class names.

The packaged acceptance suite adds an opt-in `--accept-native-window-drag` journey over the normal assembled application and keyless replay provider. With `DSH_DESKTOP_NATIVE_DRAG_REQUIRED=1`, the test requires macOS Accessibility permission, waits for each drag surface to report a screen point, and drives that point through an external CoreGraphics pointer fixture. The Electron main process observes `BrowserWindow` bounds instead of accepting a renderer self-report. The journey proves native movement from onboarding, expanded-sidebar, and collapsed-conversation chrome, then proves that dragging the composer does not move the window and still focuses the textarea. It stops through the normal lifecycle and the test checks for surviving owned processes.

Without the required environment flag, the OS-pointer journey is explicitly skipped. When the flag is present, a missing packaged application, missing fixture support, or disabled Accessibility permission is a hard failure rather than a silent downgrade.

## Alternatives considered

**Keep the entire renderer body draggable.** Rejected because topmost no-drag content can cover it, while broad drag inheritance also competes with interactive surfaces.

**Add a transparent drag overlay.** Rejected because a topmost overlay would swallow the controls and content that must remain interactive.

**Treat computed CSS or `webContents.sendInputEvent` as native-movement evidence.** Rejected because those paths can validate region configuration and renderer interaction but do not exercise the operating-system drag gesture.

**Run the CoreGraphics lane unconditionally.** Rejected because Accessibility permission is a host capability. An explicit required lane keeps ordinary local and CI runs deterministic while preventing opted-in acceptance from self-skipping.

## Consequences

- Region ownership has fast static and component coverage, while native movement has a separate packaged AppKit acceptance boundary.
- The keyless recording journey captures a named assembled drag-surface frame; `capturePage()` frames and computed styles remain useful renderer evidence but do not carry the native-movement claim.
- The required lane runs with `DSH_DESKTOP_NATIVE_DRAG_REQUIRED=1 DSH_DESKTOP_SMOKE_REQUIRED=1 DSH_E2E_MAX_WORKERS=1 pnpm exec vitest run --config vitest.e2e.config.ts apps/desktop/tests/packaged-smoke.e2e.ts -t "moves the native window from assembled chrome but not from an interactive control" --retry=0`.
- Hosts that opt into the lane must grant Accessibility access to the process running Vitest; the lane reports this prerequisite directly when it is absent.
