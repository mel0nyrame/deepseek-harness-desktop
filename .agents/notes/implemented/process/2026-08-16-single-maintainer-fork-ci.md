# Agent Note: CI runs on standard hosted runners for this single-maintainer fork

Status: implemented

English | [中文](2026-08-16-single-maintainer-fork-ci.zh.md)

## Problem

The inherited `ci.yml` resolves four jobs on the upstream organization's hosted 16-core pools (`dsh-ubuntu-24-04-16core`, `dsh-windows-2025-16core`) and schedules self-hosted standby drills on every master push. This fork has neither the pools nor the in-house VMs, so those jobs queued forever and no pull request could ever reach a verdict. Three further workflows failed or were unusable here: `issue-policy.yml` (its policy script calls the upstream repository API and 404s), `docs-pages.yml` (GitHub Pages is not enabled on this fork), and `e2b-e2e.yml` (manual, needs an E2B API key).

## Decision

Keep the workflow set to what a single maintainer needs — checks and packaging — and make every remaining job run on runners this fork actually has:

- **ci.yml** — the three required Linux jobs and the independent `windows-native` job run on standard hosted runners (`ubuntu-latest`, `windows-2025`) with concurrency tuned to 2 cores (`DSH_GATE_CONCURRENCY=2`, `DSH_COVERAGE_MAX_WORKERS=2`, `DSH_SNAPSHOT_MAX_CONCURRENCY=4`). The serial master drills and both runner-tier benchmark matrices are deleted; the workflow_dispatch trigger goes with them. The `desktop-packaged` lane runs on `macos-26`, the runner where packaging is proven (its old `macos-latest` host failed the packaging step). The wine seeding job stays: master pushes still produce the apt cache every PR restores.
- **Deleted workflows** — `issue-policy.yml`, `docs-pages.yml`, `e2b-e2e.yml`. `build-exe-for-python-sdk.yml` stays: `ci.yml`'s `python-runtime` job calls it.
- **release.yml** — after successful exhaustive tag CI, the x64 leg runs only the artifact gate plus the keyless scenario; the full GUI suite stays on arm64 (see the release-signing note).
- **CI-only corrections** — the desktop packager sets `CSC_FOR_PULL_REQUEST=true` before electron-builder because a PR-triggered build otherwise skips code signing and the evidence gate still expects the same ad-hoc signature the release legs produce. The native-boundary apiproxy tests now compare against `resolve(cwd, path)` because Windows hands the opener `C:\...` paths. The pwsh ACP header pin was refreshed on a pwsh-capable host after the background-job wording changed, and the web pwsh overlay updates the shipped disabled `tool-pwsh` row instead of inserting a duplicate id.
- **Coverage and snapshot stabilization** — desktop-app and desktop-api-client edge tests bring both new carriers to per-file 100% coverage, with v8-ignore annotations reserved for branches the public protocol cannot reach. The DeepSeek defaults snapshot now keeps a comments-only prefix of 12 × 100 ms under a 1000 ms idle watchdog, so the 2-core CI runner cannot starve the timers into a retry. The subprocess host-exit fixture announces readiness only after its process-tree state is complete, and its regression case deliberately publishes a partial file first. On Windows, the workflow worker-death suite injects the error at the real host `Worker` boundary after a child starts; POSIX retains the stronger in-worker uncaught-exception path, while Windows avoids letting Node's nested-worker assertion abort the enclosing Vitest fork.

## Alternatives considered

- **Re-create upstream's runner pools** — impossible: the larger-runner pools belong to the upstream organization.
- **Keep the upstream structure with repository guards** — preserves sync-friendliness, but leaves dead benchmark and drill machinery a lone maintainer can never exercise. Rejected: the fork is the maintainer's own project, and the workflow is already a local file.

## Consequences

- Every pull request now runs the node matrix, python lanes, Wine Windows gate, and the packaged desktop smoke on runners that exist, and `all-checks-passed` can actually complete.
- The three Linux jobs are slower on 2-core runners than upstream's 16-core pools; the concurrency values were lowered to match.
- Upstream workflow changes are no longer mechanically syncable into `ci.yml`; they arrive by hand.
