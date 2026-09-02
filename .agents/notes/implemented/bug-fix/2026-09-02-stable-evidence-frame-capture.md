# Agent Note: Stable evidence frame capture

Status: implemented

English | [中文](2026-09-02-stable-evidence-frame-capture.zh.md)

## Problem

The installed-application evidence journeys take screenshots through `capturePage()` to prove the desktop UI actually rendered. On the packaging gate's macOS runner the window compositor is software-rendered, and the first composites after `window.show()` can come back as blank images below the 20 KB painted-frame threshold. Every screenshot site retried nothing: one blank frame aborted the whole evidence journey, the installed application exited 1, and the packaging gate reported a product defect that does not exist on rendered desktops. The same single-shot pattern existed in three places (the official Client UI journey, the native-window frames, and the terminal tracer's completion frame), so fixing one site would have left the gate flaky through the others.

## Decision

All desktop screenshot evidence goes through one shared capture, `captureStableFrame(window, scope, name)` in `apps/desktop/src/frame-capture.ts`. Each attempt settles two renderer animation frames, captures the page, and accepts the image only when its PNG reaches the painted-frame threshold (20 000 bytes by default, overridable). Unpainted frames retry after a short delay until a 15-second budget is exhausted, then fail loudly with the same journey-scoped error message as before (`desktop UI|native|terminal evidence frame … is unexpectedly empty`), so a genuinely blank renderer still fails the gate. The official Client UI journey, the native-window frames, and the terminal tracer's completion frame all call this helper; the tracer's intermediate frames remain unscreenshotted-threshold captures because nothing asserts on them. The shell also sets the `disable-backgrounding-occluded-windows` Chromium switch so an occluded window keeps compositing instead of pausing mid-journey.

## Verification

`tests/desktop-frame-capture.test.ts` injects unpainted frame sequences through a structural fake: a painted first frame is accepted without retrying, an unpainted sequence retries until a painted frame arrives, an always-unpainted capture fails loudly with the journey-scoped message after exhausting the budget, and a custom minimum size is honored. `pnpm run check` and the installed-application gate (`DSH_DESKTOP_PACKAGE_REQUIRED=1 pnpm run test:package`) exercise the helper through the real Electron journeys.

## Alternatives considered

**Lower the painted-frame threshold.** Accepting tiny images would let genuinely blank frames into the evidence set and hide real rendering defects behind green runs.

**Wait longer or add more animation frames before capturing.** Time-based hope has no feedback signal; a slow CI runner could still outrun any fixed wait, while a fast local run pays the delay for nothing.

**Capture offscreen.** Offscreen rendering takes a different compositor path from the shipped product, so the gate would stop proving what users see, and it changes product runtime behavior for a testing need.

**Patch only the journey that failed on CI.** The native-window and terminal-tracer journeys would keep the same defect and re-flake the gate later; the shared helper removes the pattern once.

## Consequences

The evidence journeys keep their painted-frame guarantee on software-rendered runners, and a genuinely blank renderer still fails the gate loudly; the cost is that every screenshot site now shares one threshold and retry budget, so tuning capture behavior is a single-seam change.
