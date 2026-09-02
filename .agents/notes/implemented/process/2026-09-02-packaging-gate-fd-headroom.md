# Agent Note: Packaging gate file-descriptor headroom

Status: implemented

English | [中文](2026-09-02-packaging-gate-fd-headroom.zh.md)

## Problem

The embedded runtime closure carries roughly thirty thousand files, and electron-builder seals and signs every one of them during packaging. The signing concurrency peak exceeds the default soft file-descriptor limit on the packaging gate's macOS runner, so the gate dies with `EMFILE: too many open files` in the middle of signing — nondeterministically, because the peak drifts with timing and garbage collection. The same tree packaged cleanly on earlier runs (GitHub Actions run 33577883843 failed; runs over the identical content succeeded), which makes the gate unreliable rather than the product broken.

## Decision

The gate raises the file-descriptor ceiling instead of shrinking the runtime. The CI packaging step raises the soft limit toward 65 536 before running the package script, falling back to the host's own hard ceiling when that value is not permitted. As a second layer, `scripts/package-desktop.ts` wraps the electron-builder build: a failure whose error reports `EMFILE` triggers exactly one clean retry (the output directory is removed and recreated first), because a fresh attempt under the same limit usually completes once the timing drift resets. Every other failure surfaces immediately. The packaging script itself is not re-invoked through a shell, and the packaged content is unchanged.

## Verification

Locally, `ulimit -n 256 && pnpm run package` reproduced the signing-stage `EMFILE` with the same shape as the CI failure (a random runtime file named in the error), and packaging succeeds with the raised limit. `tests/desktop-package.test.ts` keeps pinning the `package` script command and the dry-run contract, so the fix stays out of the script's invocation surface.

## Alternatives considered

**Disable or replace electron-builder's macOS signing.** Apple Silicon refuses to launch unsigned binaries, and the gate must start the installed application; ad-hoc signing cannot be skipped.

**Strip source maps from the runtime closure.** Fewer files lower the peak but leave the gate coupled to whatever fd ceiling the host has, and drop the stack mappings that crash triage relies on.

**Patch electron-builder.** The dependency is pinned to an exact published version; carrying a fork would trade a one-line resource setting for a permanent upgrade tax.
