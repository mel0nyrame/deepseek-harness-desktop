# Agent Note: CI execution and recovery runbook — standard GitHub-hosted capacity

Status: implemented

English | [中文](2026-07-26-ci-failover-runbook.zh.md)

## Problem

Required checks need one current recovery procedure. The earlier topology depended on enterprise labels, self-hosted standby pools, and repository-variable switches. None of those selectors, variables, or standby lanes exists in the current workflow, so following that procedure would change no job and could delay diagnosis.

## Decision

<<<<<<< HEAD
[CI](../../../../.github/workflows/ci.yml) uses only explicit GitHub-hosted capacity and has two event tiers:
=======
Each of the three required Linux worker jobs, the independent native Windows job, and the `all checks passed` verdict job — which would otherwise stay queued on the failed pool even after every worker passed — resolves its runner pool through a repository variable, and the switch is split by platform so an outage on one platform does not retarget the other. The three Linux workers and the `all checks passed` verdict (whose `needs` are the required Linux workers and which runs on the `vm-backup` pool) resolve through `DSH_CI_FAILOVER_LINUX`; the native Windows job resolves through `DSH_CI_FAILOVER_WINDOWS`. Unset (normal), they run on the hosted enterprise pools. Set to `selfhosted` by any repository writer, the corresponding jobs retarget onto the in-house self-hosted pool: under `DSH_CI_FAILOVER_LINUX`, the Linux jobs and verdict move onto the `vm-backup` pool, snapshot concurrency drops to the shared-VM bound, and the hosted-path pnpm cache restores are skipped; under `DSH_CI_FAILOVER_WINDOWS`, the native Windows job moves onto the `dsh-win-ci` pool. Each switch is writer-manageable repository state, not a merge, so it works while every check is red. The in-house pools' readiness is continuously re-proven by the `serial / linux (self-hosted standby)` and `serial / windows (self-hosted standby)` lanes, which run the complete unsharded aggregates on every master push.
>>>>>>> upstream/master

- Pull requests run `pr-node`, `pr-python-sdk`, and the `pr checks passed` aggregate. They preserve the fast review contract.
- Pushed `v*` tags run eight exhaustive jobs — static, coverage, snapshots, artifacts, Node compatibility, Python SDK, Python runtimes, and native Windows — followed by `tag checks passed`.

The workflow has no `master`-push lane, repository-variable runner selector, enterprise label, or self-hosted standby. Wine is local-only. Platform behavior that requires native Windows runs on `windows-2025`; macOS DMG work starts in the separate release workflow only after the tag aggregate succeeds.

### Recovery

1. Classify the failure from the Actions run: a queued or image/provisioning failure is runner capacity; a command exit is a product, test, dependency, or workflow failure.
2. For a transient hosted-runner failure, re-run the failed jobs. If jobs never started, cancel the run and re-run all jobs so GitHub allocates fresh runners.
3. For a reproducible command failure, fix it through a pull request and let the ordinary PR checks pass. Never skip a required aggregate or replace its result manually.
4. For a failed release tag, re-run only transient failures. When repository content or workflow logic must change, merge the fix and create the next version tag on the new commit; do not move a tag that may already identify a published release.
5. A capacity-provider change is a workflow change. It requires a reviewed pull request, a trust-boundary review, and workflow-structure spec updates; there is no out-of-band failover switch.

<<<<<<< HEAD
The release workflow runs with write permission only after a successful CI `workflow_run` for a pushed product tag. It verifies that the checked-out tag resolves to the CI run's exact commit before reading release notes, building DMGs, or creating a release.
=======
`vm-backup`: one 64-core VM, six always-on systemd-managed runner instances. Its image must preinstall Playwright Chromium's Linux system packages; CI downloads the lockfile-selected browser but never runs `apt` on this persistent shared host. Check the latest `serial / linux (self-hosted standby)` run before switching: its aggregate includes browser replay, so a green standby verifies both ordinary capacity and this browser prerequisite.

#### Windows pool

`dsh-win-ci`: 32 always-on runner instances (scheduled tasks `GH-Runner-01`…`GH-Runner-32`) on the in-house Windows CI server (one 96-core / 580 GB machine). Labels: `[self-hosted, dsh-win-ci, windows]`. The image must preinstall Node 24, pnpm, Git (with Git Bash on `PATH`, i.e. `C:\Program Files\Git\bin` — the `bash` tool spawns `bash` by name), PowerShell 7, and enable Developer Mode for symlink support. Check the latest `serial / windows (self-hosted standby)` run before switching: a green standby verifies the pool can execute `check:ci:windows-complete` end-to-end.

### Switch (any repository writer, ~1 minute, no merge)

The two switches are independent: flip only the one whose platform is degraded.

1. Repository **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `DSH_CI_FAILOVER_LINUX` (Linux pool outage) or `DSH_CI_FAILOVER_WINDOWS` (Windows pool outage), value `selfhosted`.
2. Retrigger the required jobs so they re-resolve their pool. Jobs already **queued** for the hosted labels do not retarget and cannot be re-run in place, so for the documented indefinite-queue outage, cancel the stuck run and re-run all jobs, or push a new commit; "Re-run failed jobs" only helps once a job has actually failed rather than queued.
3. That is the entire switch. Under Linux failover the workflow also drops `DSH_SNAPSHOT_MAX_CONCURRENCY` to 12 for the shared VM and skips the hosted-path pnpm cache restores because the VM's persistent store serves warm installs. Coverage uses the same four single-worker instrumented partitions and two exempt workers on both Linux pools. The Windows switch has no concurrency or cache branches; it only retargets the native Windows job's pool.

#**Dependabot exception.** Both switches' selectors deliberately exclude `dependabot[bot]`: under failover, Dependabot PRs stay queued for the hosted pool rather than executing dependency-supplied code on the persistent VMs. A Dependabot PR that remains queued during an outage is expected behavior, not a failed switch; it completes when the hosted pool recovers.

**Who can flip the variable.** GitHub's API lets any collaborator with write access manage repository variables, so each switch is writer-level, not strictly admin-only. In this repository's trust model that is not an escalation: the runner groups admit all workflows of this private, fork-disabled repository (a deliberate trade to make PR-ref failover possible at all), so any writer could already reach the VMs by pushing a branch workflow. The boundary against untrusted code is repository membership; the variables only route work for members.

## Capacity during failover

Six always-on instances absorb normal PR traffic (the pool's steady-state load is one serial standby job per master push, so failover capacity is effectively the full pool). If queues still build, register additional instances with an org registration token (org Settings → Actions → Runners → New runner). Clone an existing runner directory **excluding its identity files** — `rsync -a --exclude '.runner*' --exclude '.credentials*' --exclude '_diag' --exclude '_work' <src>/ <dst>/` (the globs also catch `.runner_migrated`/`.credentials_migrated`, which GitHub writes on migrated runners and which equally trigger the already-configured refusal) — then run `config.sh` (copying `.runner`/`.credentials` verbatim makes it refuse with "already configured"), and **start the listener**: `sudo ./svc.sh install ubuntu && sudo ./svc.sh start`. Registration alone leaves the runner offline; only a started service adds capacity. About a minute per instance.


### Switch back

Delete the `DSH_CI_FAILOVER_LINUX` or `DSH_CI_FAILOVER_WINDOWS` variable (or set it to anything other than `selfhosted`). New runs resolve back to the hosted enterprise pools. Remove any extra instances that were registered during the incident.

### Trust boundary

The variables are writer-manageable repository state; a pull request event itself can neither set them nor read a different value into effect, and the selector expressions live in workflow definitions. Note that under failover, `pull_request` runs execute the PR merge ref's own workflow definition — the boundary against untrusted code is repository membership (private, forking disabled, Dependabot excluded by the selectors), not the variable. Note on runner-group policy: pinning the runner group to the master-ref workflow is **incompatible** with this failover — the five failover jobs are `pull_request` runs evaluated from PR merge refs, and a master-pinned group leaves them queued (observed live on 2026-07-27; the group was widened to all workflows of this repository to unblock the switch). A stricter runner-side policy therefore costs PR failover; the shipped posture accepts repository-scoped, all-workflow group access.
>>>>>>> upstream/master

## Alternatives considered

**Retain dormant failover variables.** Rejected because an unexercised selector is misleading operational surface. A switch that has no continuously proven target is not a recovery mechanism.

**Keep self-hosted runners in the required path.** Rejected because the repository currently has no maintained self-hosted trust or image contract. Standard hosted runners keep the required path reproducible from repository state.

## Consequences

<<<<<<< HEAD
- Recovery uses GitHub re-runs for transient capacity failures and ordinary reviewed fixes for deterministic failures.
- There is no instant provider switch during a broad GitHub-hosted outage; checks remain queued until capacity returns or a reviewed topology change lands.
- `scripts/ci-workflow.spec.ts` pins both event tiers and their aggregates, so a topology change updates the runbook and its executable structure contract together.
=======
Recovering from a hosted-pool outage is flipping the affected platform's variable (any writer) plus a re-run, with no merge on the critical path. The cost is a second runner topology per platform to keep working: the standby lanes exercise them on every master push so the failover targets never go stale, and the snapshot-concurrency and cache-restore branches in `ci.yml` carry a `selfhosted` leg (Linux only) that must stay in step with the hosted leg. Splitting the switch by platform adds one more variable to manage but bounds the blast radius of each switch to the jobs of a single platform.
>>>>>>> upstream/master
