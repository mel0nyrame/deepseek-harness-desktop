---
name: dsh-pre-push-checks
description: Use before pushing, force-pushing, marking ready for review, or claiming checks pass on a deepseek-harness-desktop branch, and immediately after gh stack sync publishes rewritten branches, to select the smallest tests and checks that cover the outgoing or just-published diff without reflexively running the full repository suite.
---

# DSH Pre-Push Checks

Use this skill to run relevant local evidence once before a `deepseek-harness-desktop` push. The sole ordering exception is `gh stack sync`, which may publish a cascading rebase before the rewritten layers can be validated; validate them immediately afterward and do not merge until the evidence passes. The repository currently has no git hooks; CI owns exhaustive coverage and the platform matrix.

## Inspect the outgoing change

1. Confirm the checkout and branch.

```sh
git status --short --branch
git rev-parse --show-toplevel
```

2. Verify the live PR base or stack parent, fetch that ref, and inspect the complete scope against it.

```sh
git diff --name-status <verified-base-ref>...HEAD
git status --short
```

The diff never guesses or fetches a base. Supply the ref verified from current remote or stack state; `--name-status` lists committed paths relative to the resolved merge base, while staged, unstaged, and untracked paths describe the current worktree. After merging a changed base, rerun the inspection, reassess which behavior the combined scope can affect, and rerun only checks invalidated by the merge.

## Select relevant evidence

There is no universal local baseline beyond the hooks. Every behavior change needs the narrowest available test or purpose-built check that would fail for its regression; add broader checks only for surfaces the diff actually reaches.

- **Package or script behavior:** run the owning Vitest file or focused test name. Add adjacent package tests when a shared contract changes; leave repository-wide coverage to CI unless the change is genuinely cross-cutting or the user requests it.
- **Documentation, Agent Notes, or doc-linked comments:** run `pnpm run lint` and `git diff --check`; run the repository-layout test (`pnpm run test:layout`) when the change touches agent-development resources or the workspace boundary.
- **Model-, editor-, CLI-, or terminal-visible output:** run the focused keyless snapshot or real runnable-example scenario that owns the output.
- **Package manifests, public exports, or build configuration:** run `pnpm run check`; when a build exists, run it and the owning built-artifact smoke.
- **Real provider or agent behavior:** run the relevant end-to-end target when one exists and credentials are available; never print secrets.

Do not manually repeat a passing check merely because commit or push follows. In particular, do not run typecheck immediately before pushing solely to duplicate the pre-push hook.

### Focus unit coverage on the affected source

Test selection and coverage selection are separate. A Vitest file filter chooses which tests run, while the repository configuration otherwise measures every `packages/*/src/**/*.ts` and `apps/*/src/**/*.ts` file. When unit coverage is relevant, name both the owning tests and the source files or package whose coverage those tests must prove:

```sh
pnpm exec vitest run packages/<role>/tests/<behavior>.spec.ts \
  --coverage \
  --coverage.include='packages/<role>/src/**/*.ts'
```

Use an exact source file when the behavior is truly confined to one module. Repeat `--coverage.include` for multiple affected files or packages, and pass every owning test file needed to exercise that scope. The configured per-file 100% thresholds still apply inside the selected source scope.

When the owning tests are unclear, use Vitest's dependency graph to discover a candidate set, then inspect the selected tests before treating the run as evidence:

```sh
pnpm exec vitest related packages/<role>/src/<changed>.ts \
  --run \
  --coverage \
  --coverage.include='packages/<role>/src/<changed>.ts'
```

`vitest related` cannot discover behavior reached only through configuration, dynamic loading, subprocesses, workers, built artifacts, or external providers; select those owning tests explicitly. Do not use `--passWithNoTests`, lower coverage thresholds, or narrow `--coverage.include` merely to hide an uncovered affected file. If a selected package scope fails because one focused test does not cover it, add its other relevant owning tests or narrow the source scope only when the excluded modules cannot be affected by the change.

## Full local rehearsal

Run the complete local approximation only when the user explicitly requests it, while diagnosing a CI failure, or when the change spans the repository so broadly that no narrower set is credible. Use the current workflow and package scripts as the inventory (`pnpm run check`).

## Protect history-rewriting pushes

Rebase is allowed for standalone and stacked PR branches, including after review. Before a standalone history rewrite, fetch the current remote branch and record its exact OID; publish with `--force-with-lease=<branch>:<observed-oid>` so a concurrent update aborts the push. `gh stack push` and `gh stack sync` supply lease protection for their managed branches. Raw `--force` is never allowed.

After any rewritten push, fetch the live heads again and re-audit unresolved review threads, approvals, mergeability, and checks. Commit hashes and inline-comment anchors from before the rewrite are not current evidence.

### Post-sync validation

`gh stack sync` fetches, cascade-rebases, and pushes as one operation, so it cannot place local validation between rewrite and publication. Before running it, require a clean worktree and record the official stack order and exact remote heads. After it returns:

1. Re-query every branch head and the official GitHub stack order.
2. Inspect the changed scope of every rewritten layer against its live PR base.
3. Run the relevant evidence selected by this skill for each affected layer.
4. Keep every PR unmerged and report validation as pending until all selected checks pass.

If post-sync evidence fails, leave the lease-protected published heads in place, repair the failure, validate the repair, and publish the correction. Do not claim the sync made the stack ready merely because the command succeeded.

## Handle failures

If a relevant check fails before an ordinary push, stop and fix or explain the blocker. Do not push and hope CI differs. For the post-sync exception, block the merge and follow the repair procedure above.

If a failure looks environment-specific, prove it:

- Record the exact command, failing test, and platform-specific mismatch.
- Confirm the relevant non-platform evidence.
- Prefer fixing cross-platform nondeterminism when the check is required.
- Bypass a local hook only when the user explicitly asks or agrees, and report exactly what failed and why CI is expected to differ.

## Push procedure

For ordinary and standalone rebase pushes:

1. Run the selected relevant checks once.
2. Commit normally and inspect any files changed by the pre-commit fixer before continuing.
3. Push normally, or use the exact lease for an authorized rewritten branch, so the incremental typecheck hook runs.
4. Verify the remote ref matches local `HEAD`.

```sh
git rev-parse HEAD origin/$(git branch --show-current)
```

For GitHub PRs, inspect remote CI after the push:

```sh
gh pr checks
```

Report pending checks as pending. Inspect failures before attributing them to the branch or the environment.

For `gh stack sync`, use the post-sync validation sequence instead of pretending the ordinary order was possible.
