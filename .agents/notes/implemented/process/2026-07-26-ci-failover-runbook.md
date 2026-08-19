# Agent Note: CI execution and recovery runbook — standard GitHub-hosted capacity

Status: implemented

English | [中文](2026-07-26-ci-failover-runbook.zh.md)

## Problem

Required checks need one current recovery procedure. The earlier topology depended on enterprise labels, self-hosted standby pools, and repository-variable switches. None of those selectors, variables, or standby lanes exists in the current workflow, so following that procedure would change no job and could delay diagnosis.

## Decision

[CI](../../../../.github/workflows/ci.yml) uses only explicit GitHub-hosted capacity and has two event tiers:

- Pull requests run `pr-node`, `pr-python-sdk`, and the `pr checks passed` aggregate. They preserve the fast review contract.
- Pushed `v*` tags run eight exhaustive jobs — static, coverage, snapshots, artifacts, Node compatibility, Python SDK, Python runtimes, and native Windows — followed by `tag checks passed`.

The workflow has no `master`-push lane, repository-variable runner selector, enterprise label, or self-hosted standby. Wine is local-only. Platform behavior that requires native Windows runs on `windows-2025`; macOS DMG work starts in the separate release workflow only after the tag aggregate succeeds.

### Recovery

1. Classify the failure from the Actions run: a queued or image/provisioning failure is runner capacity; a command exit is a product, test, dependency, or workflow failure.
2. For a transient hosted-runner failure, re-run the failed jobs. If jobs never started, cancel the run and re-run all jobs so GitHub allocates fresh runners.
3. For a reproducible command failure, fix it through a pull request and let the ordinary PR checks pass. Never skip a required aggregate or replace its result manually.
4. For a failed release tag, re-run only transient failures. When repository content or workflow logic must change, merge the fix and create the next version tag on the new commit; do not move a tag that may already identify a published release.
5. A capacity-provider change is a workflow change. It requires a reviewed pull request, a trust-boundary review, and workflow-structure spec updates; there is no out-of-band failover switch.

The release workflow runs with write permission only after a successful CI `workflow_run` for a pushed product tag. It verifies that the checked-out tag resolves to the CI run's exact commit before reading release notes, building DMGs, or creating a release.

## Alternatives considered

**Retain dormant failover variables.** Rejected because an unexercised selector is misleading operational surface. A switch that has no continuously proven target is not a recovery mechanism.

**Keep self-hosted runners in the required path.** Rejected because the repository currently has no maintained self-hosted trust or image contract. Standard hosted runners keep the required path reproducible from repository state.

## Consequences

- Recovery uses GitHub re-runs for transient capacity failures and ordinary reviewed fixes for deterministic failures.
- There is no instant provider switch during a broad GitHub-hosted outage; checks remain queued until capacity returns or a reviewed topology change lands.
- `scripts/ci-workflow.spec.ts` pins both event tiers and their aggregates, so a topology change updates the runbook and its executable structure contract together.
