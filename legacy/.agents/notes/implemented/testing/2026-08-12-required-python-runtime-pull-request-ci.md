# Agent Note: Required Python runtime pull-request validation

Status: implemented

English | [中文](2026-08-12-required-python-runtime-pull-request-ci.zh.md)

## Problem

Ordinary pull-request CI runs the complete Python SDK pytest suite against fake runtime peers, while Node snapshots exercise different clients and expected outputs. The real Python client, packaged JSON-RPC executable, executable-specific snapshot, release-shaped wheels, and clean installation meet only in the optional single-executable or Python release workflows. A runtime event change or closure change can therefore merge with a stale Python projection or broken wheel path and fail only when someone later builds a Python release candidate.

## Decision

The [PR/tag CI tiering decision](../process/2026-08-19-pr-tag-ci-tiering.md) supersedes this note's original merge-time executable requirement. Every pull request runs the required `pr-python-sdk` job in [CI](../../../../.github/workflows/ci.yml), which executes the complete keyless Python SDK suite. Release-shaped validation runs on `v*` tags through `tag-python-runtime`, which calls the shared [single-executable builder](../../../../.github/workflows/build-exe-for-python-sdk.yml) for linux-x64, linux-arm64, and macos-arm64 and participates in `tag-checks-passed`.

The shared builder constructs the real executable, runs all keyless Python full-turn and direct-binary scenarios including both committed snapshots, builds the SDK and runtime wheels, installs them into a clean virtual environment, checks the executable and native addon's deployment requirements, and runs Linux wheels in a manylinux 2.28 container. Linux deletes the resolved `node-pty` build directory and invokes the lockfile-resolved node-gyp before the manylinux rebuild; pnpm's side-effects cache may otherwise restore generated relative paths from another installation topology.

The advanced executable snapshot normalizes opaque session, message, subagent, and workflow-run identifiers before comparison. A newly persisted workflow event therefore changes the reviewed expected output without making a random run identifier part of that output. The minimal scenario's [model-visible snapshot](2026-08-13-python-minimal-model-visible-snapshot.md) covers the assembled system prompt, tool schemas, and message list that this one tokenizes.

## Alternatives considered

**Run the complete native matrix on every pull request.** This duplicates platform-independent full-turn and snapshot behavior across three jobs and consumes ARM64 Linux and macOS capacity on every change. The publication workflow retains that evidence at the point where all three artifacts are required.

**Run the snapshot against the development Node carrier.** This catches protocol and event projection drift but does not prove pkg assembly, the deployed runtime closure, native addon staging, wheel construction, exact dependency pins, or clean installation. The tag runtime builder covers the published path directly.

**Select the Python SDK job with path filters or labels.** Python behavior depends on shared agent, session, workflow, subagent, and plugin-loading code outside `python/`. An incomplete dependency filter recreates delayed projection failures, and a label leaves the evidence optional.

## Consequences

Every pull request pays only for the complete keyless Python SDK suite, so client projection failures still block merge without the cost of packaging native runtimes. Executable, addon, wheel, and clean-install regressions can surface later than the pull request and are instead blocked by the three-target tag gate before publication.
