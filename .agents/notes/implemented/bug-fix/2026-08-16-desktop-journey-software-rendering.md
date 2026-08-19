# Agent Note: Desktop evidence journeys render with hardware acceleration disabled

Status: implemented

English | [中文](2026-08-16-desktop-journey-software-rendering.zh.md)

## Problem

The issue #9 release matrix's x64 leg hung in the packaged-app acceptance journey: the app logged "Host phase: running" and then stopped, until the test's 120s kill timer fired. The captured output carried `ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer` from the GPU process. The Intel runner is a VM without a reliable GPU: when the command-buffer handshake fails transiently, the renderer's script channel wedges and every `executeJavaScript` wait hangs with no timeout. The arm64 runner and local machines reproduce it rarely, so the flake looked x64-only. The SIGKILLed journey then orphaned its DSH child and PTY, and the leftover processes polluted every later test's quiescence assertion.

## Decision

Evidence journeys render through software compositing: when any journey flag is present (`--inspect-native-window`, `--accept-native-window`, `--record-native-window`, `--record-native-actions`, `--record-recovery`, `--smoke`, `--smoke-reopen`), `main.ts` calls `app.disableHardwareAcceleration()` at module scope, before `ready`. Software rendering keeps every journey paint and `capturePage` frame deterministic across machines, which the journeys need anyway — their evidence claims compare bounds, regions, and frames, not GPU throughput. The interactive product launch keeps hardware acceleration.

## Alternatives considered

- **CI-only `--disable-gpu` switch** — keeps product code untouched, but the flag must be threaded through the test launcher and the journeys stay GPU-dependent for anyone recording evidence on a GPU-less host. Rejected: the journey modes exist to produce deterministic evidence, so the switch belongs in the product's mode handling.
- **Bounded `executeJavaScript` waits** — a timeout converts the hang into a fast failure but does not make the evidence runnable on the Intel runner. Rejected as a fix; the existing 30s `waitForRenderer` deadline already bounds the polling loop, not the wedged script channel.

## Consequences

- Journey launches do not touch the GPU process for compositing; the transient command-buffer failure mode cannot wedge their script channel.
- The packaged smoke now passes the acceptance and recording journeys on the Intel matrix runner, which is the only lane that exercises x64 at all.
