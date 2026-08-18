# Agent Note: PR/tag CI tiering

Status: implemented

English | [中文](2026-08-19-pr-tag-ci-tiering.zh.md)

## Problem

The previous CI ran exhaustive coverage, snapshots, artifacts, Node compatibility, Wine, native Windows, desktop packaging, and release-shaped Python runtime checks on every pull request. This made the required PR path slow, consumed paid runner minutes, and allowed a Wine apt dependency drift to block merges before product gates started. The release-shaped Python runtime also reused a stale node-pty build tree when pnpm side-effects caches restored invalid Makefile paths.

## Decision

Ordinary pull requests now run only the essential PR lane in [ci.yml](../../../../.github/workflows/ci.yml): `pr-node` installs once and runs `pnpm run check:ci:pr` (static gates plus the full unit suite), and `pr-python-sdk` runs the Python SDK pytest suite. `pr-checks-passed` aggregates those two jobs.

All exhaustive checks move to `v*` tag pushes. `ci.yml` defines eight parallel tag jobs: static, coverage, snapshots, artifacts, Node 22.19/26 compatibility, Python SDK, release-shaped Python runtimes (three native targets), and native Windows complete, aggregated by `tag-checks-passed`. The Wine blocking job and its master cache seeder are removed from automated CI; the local `check:windows-wine` command remains.

The Python runtime builder is now `workflow_call` only, with no `ci` input and no manual/label entry points. Its Linux node-pty step deletes only the resolved addon's `build` directory and then invokes the lockfile-resolved node-gyp directly, so the manylinux Makefile is regenerated before the container build.

Other full workflows are also tag-only: `desktop-release.yml` builds both macOS architectures on `v*`; `sandbox.yml` runs kernel-confinement proofs on `v*`; and `landlock-run.yml` keeps a path-filtered lightweight PR native job while its full native matrix and darwin proof run on tags.

## Consequences

PR CI is faster and cheaper, and the required verdict no longer waits on coverage, snapshot, artifact, Wine, or native platform jobs. Tag validation is the formal release gate and must be run before publication. The three confirmed faults from run 32165982771 are addressed: Wine no longer blocks CI, snapshots have hard timeouts and are split from artifacts, and the Python runtime rebuild cannot reuse a stale Makefile.

## Alternatives considered

**Keep exhaustive checks on every PR.** Rejected because it makes the common path slow and expensive, and the Wine failure demonstrated that a low-fidelity simulation can block merges without adding release confidence.

**Keep Wine as a required PR job with a longer timeout.** Rejected because the native Windows tag job provides higher fidelity, and Wine's apt dependency closure is not stable enough for automatic CI.

**Run only static checks on PR and defer all tests to tag.** Rejected because the full unit suite is fast enough to keep in the PR essential lane and catches regressions before tag validation.
