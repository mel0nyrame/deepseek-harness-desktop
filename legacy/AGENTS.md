# AGENTS.md

DeepSeek Harness is a pnpm-workspace, plugin-composed agent runtime on vendored Cordis: **everything is a plugin**. Before changing `packages/`, read [the architecture](docs/architecture.md); narrower `AGENTS.md` files apply.

## Pre-release stance: foundation over blast radius

**Remove at the first tagged release.** Prefer foundations over compatibility shims; rename or repackage and update every reference. Backends reject old disk formats. SQLite increments `SCHEMA_VERSION`; `SESSION_FORMAT_VERSION` stays `0`.

## Commands

[`package.json`](package.json) is the command inventory. Common non-standard entry points:

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test:coverage   # CI coverage semantics
pnpm run doc-sync       # documentation gates
pnpm run hygiene        # package and workspace constraints
```

Real-API tests and demos read `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`, and root `.env`; never commit credentials. Cordis `config` and `disabled` use `!!js`, never `!js`.

### Run relevant checks locally

Before publishing, use [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md): focused behavior tests, snapshots for visible output, `doc-sync` for docs, and build/hygiene plus built smokes for published paths. CI owns exhaustive coverage and platform matrices. Validate immediately after `gh stack sync`.

If the host sandbox blocks a required command's credentials, network, IPC, file watching, or nested sandbox, retry unchanged with the narrowest escalation. Never bypass product-sandbox or test failures.

## Conventions

- Harness packages are `@deepseek-ai/dsh-<name>` with peer+dev Cordis; vendored packages are rescoped and private ([mapping](docs/rescope.md)). Use ESM package imports across packages and `.ts` locally. Config subprocesses run built `lib/`; source regressions use their [declared launcher](docs/testing.md#test-subprocess-launch-modes). Raw/Web Cordis bare plugins belong in resolver `dependencies`.
- Registrations are effects through `ctx.effect()` or `ctx.on()`; registry `register()` methods return disposers. Waterfall listeners call `next()` to delegate ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- Runtime invariants assert owned event or mutable-data relationships, not service presence, metadata, effects, or fixed pure examples ([package rules](packages/AGENTS.md)).
- Typed events use declaration merging and merge-extensible maps. Event JSDoc includes `@mode`/payload `@param`; public services document parameters and non-void returns. Missing scoped keys use `@dshScopeScan unsupported`. `SessionEventMap` is required-on-read unless `ignorable: true`; only structural changes bump `SESSION_FORMAT_VERSION` ([mechanism](.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md)).
- Switch closed discriminated unions through `assertNever`; merge-extensible unions use a documented default.
- Anything model-visible is reconstructable from the session log. Add a session event for each new model-visible input.
- Extend through documented plugin points. Changing `agent-loop` requires updating [architecture.md](docs/architecture.md).
- A capability seam includes Service Definition, Service Provider, and Consumer roles; split roles only when they evolve independently ([glossary](docs/glossary.md#capability-seam)).
- Prefer a maintained dependency when it deletes owned implementation and tests ([policy](.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md)).
- Resolve defaults explicitly in the owning implementation before execution. Deployment tunables are validated `Config` fields; protocol, external-spec, and security constants remain fixed.
- Fail misconfiguration at load when self-contained, otherwise at its earliest resolvable point. Brand opaque cross-boundary ids with `Branded<B>`.
- Trust TypeScript inside typed same-process calls. Validate parser/config, model/tool JSON, durable/file, worker, process, and wire inputs.
- Static gates and tests resolve workspace imports to `src`; built-output consumers declare their build dependency. Seed repo-wide compiler programs from the Host or Client aggregate, never the root solution ([layout](docs/development.md#typescript-project-layout)).
- An empty `catch` names the swallowed error and why no other error can reach it; keep the `try` to one statement.
- Tests describe behavior, not correctness. Change obsolete behavior with its tests and explain why in the PR.
- Every non-trivial change adds or updates an [Agent Note](.agents/notes/README.md#when-to-write-one). Archived notes are frozen history.
- Visible behavior needs a real keyless snapshot plus focused tests; fixtures replay on macOS/Linux. Agent-loop, session-lifecycle, and `SessionEventMap` changes update both SDK projections ([testing policy](docs/testing.md)).
- Decide tool UI intent (`generic`/`terminal`/`diff`, `locations`) before implementation; presentation is pure from arguments ([cookbook](docs/cookbook/adding-a-tool.md)).
- TypeScript stays strict. Prose states current contracts, not code, review, or reasoning narration. Public function-like exports use concise JSDoc. Update affected README/JSDoc; follow [documentation rules](docs/AGENTS.md).
- Rewrites use `--force-with-lease`, never raw `--force`; checkpoint an in-progress merge-forward before taking a newer base ([rationale](.agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.md)).
- Files end with one trailing newline. TODO markers use `FIXME`, `TODO`, and `XXX` in decreasing urgency ([semantics](docs/development.md#todo-markers)).

Read [defensive patterns](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work and [testing policy](docs/testing.md) before coverage design. Update `vendor/` only through [its procedure](vendor/README.md).

## Agent resources

Issues/specs use [GitHub Issues](docs/agents/issue-tracker.md); triage uses [canonical labels](docs/agents/triage-labels.md); terminology and ADRs use [domain docs](docs/agents/domain.md).

`CLAUDE.md` symlinks the corresponding `AGENTS.md` at root, `packages/`, and `examples/`; edit the real file.
