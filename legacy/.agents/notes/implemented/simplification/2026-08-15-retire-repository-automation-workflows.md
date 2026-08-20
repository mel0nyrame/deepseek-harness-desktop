# Agent Note: Retire repository automation workflows

Status: implemented

English | [中文](2026-08-15-retire-repository-automation-workflows.zh.md)

## Problem

Several GitHub Actions lanes duplicated operations that remain available through repository commands, consumed external credentials, or projected issue state automatically. Keeping those lanes made GitHub configuration an additional execution and credential surface even when the repository did not require those operations to run remotely.

## Decision

GitHub Actions retains the reusable Python runtime builder, issue policy, CI, documentation pages, sandbox, Landlock CI, and the manually triggered E2B integration suite. The separate real-API provider suites, package publication lanes, expected-filename lane, and issue-lifecycle projection lane are absent.

Release preparation, verification, packing, and publication remain repository-owned local commands. Landlock publication requires native builds for each supported architecture to be transferred into one clean checkout before the existing assemble, verify, pack, installed-copy verification, and registry-aware publish scripts run. Python runtime wheel construction remains available through the reusable builder and GitLab CI, but GitHub no longer assembles or publishes a public Python release candidate. Issue lifecycle handlers and their unit tests remain source capabilities without a GitHub event subscriber.

## Alternatives considered

**Keep dormant manual workflows.** Manual triggers still retain credential, configuration, and maintenance surfaces, so inactivity alone does not simplify repository automation.

**Move removed release lanes into the main CI workflow.** This would mix credential-free pull-request checks with protected publication and external-service operations instead of removing the remote execution surface.

**Remove the underlying scripts and tests with the workflows.** The local release commands, reusable runtime builder, and issue-management logic remain useful independently of GitHub event wiring.

## Consequences

GitHub no longer schedules or manually dispatches the removed operations. Maintainers run releases from authenticated local environments and are responsible for preserving native-architecture provenance and inspecting local artifacts before publication. Real-API coverage is local rather than a GitHub merge signal, and issue status projection does not run automatically.

The retained workflows continue to cover pull-request CI, documentation, sandbox behavior, Landlock native builds, Python runtime construction for callers, issue policy, and the explicit E2B live integration lane. Reintroducing a removed lane requires a current need for remote execution, an explicit trigger and credential model, and focused tests for its failure modes; local commands remain the default when they provide the same capability.

This decision consolidates the former dedicated DeepSeek real-API CI and Python publication decisions. Their original goals—detecting integration failures that keyless tests cannot expose and publishing one validated multi-wheel set—remain valid, but they no longer justify secret-bearing or publication-capable GitHub workflows. Local real-API runs and the retained build and release scripts preserve those capabilities without remote scheduling.

Any future secret-bearing pull-request lane must use `pull_request`, never `pull_request_target`, rely on GitHub withholding secrets from forks and Dependabot, and fail before a self-skipping suite can report false green when its expected secret is absent. Enabling trusted same-repository pull requests accepts that write-capable contributors can execute code with repository secrets; omitting that trigger limits exposure but gives up the pre-merge live signal.

Any future Python publication lane must publish only the exact checked wheel bytes, verify retained hashes before upload, publish all runtime wheels before the SDK that pins them, and keep publication jobs separate so an SDK retry never replaces immutable runtime files. Trusted Publishing identity includes the repository, workflow, and environment; changing any of them requires updating the PyPI publisher. A token-based alternative restores a reusable secret and its rotation burden.

Any future Issue lifecycle subscriber must preserve the event-command model: repeated review requests target `In review`, changes-requested reviews target `In progress`, and the only backward transition must verify that automation owns the latest Project status. Approved, commented, and dismissed reviews must not create a lifecycle mutation. Keeping the handlers without an event subscriber is intentional; reintroducing automatic projection requires restoring focused workflow-event coverage as well as handler tests.
