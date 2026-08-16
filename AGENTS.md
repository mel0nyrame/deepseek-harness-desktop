# AGENTS.md

DeepSeek Harness is a plugin-composed agent runtime on vendored Cordis: **everything is a plugin**. This repository uses pnpm workspaces. Before changing `packages/`, read [the architecture](docs/architecture.md); narrower `AGENTS.md` files add subtree rules.

## Pre-release stance: foundation over blast radius

**Remove at the first tagged release.** Without external consumers, prefer foundations over compatibility shims: rename or repackage and update all references. Backends reject old disk formats. SQLite increments `SCHEMA_VERSION`; `dsh-session` keeps `SESSION_FORMAT_VERSION` at `0` without compatibility.

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

Real-API tests and demos read `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`, and the root `.env`; never commit credentials. Use `!!js`, never `!js`, under Cordis `config` and `disabled`.

### Run relevant checks locally

Use [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md) before publishing a branch. Run the smallest checks that cover the diff: focused tests for behavior, snapshots for model or visible output, `doc-sync` for docs, and build/hygiene plus built smokes for published paths. CI owns exhaustive coverage and platform matrices. After `gh stack sync`, validate the rewritten branches immediately.

When a required `gh`, pnpm, build, test, or generator command fails with evidence that the host sandbox blocked credentials, network, IPC, file watching, or nested sandboxing, retry unchanged with the narrowest host escalation. Never bypass a product-sandbox or test failure.

## Conventions

- Registrations are effects through `ctx.effect()` or `ctx.on()`; registry `register()` methods return disposers. Waterfall listeners call `next()` to delegate ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- Runtime invariants assert owned event or mutable-data relationships, not service presence, metadata, effects, or fixed pure examples ([package rules](packages/AGENTS.md)).
- Typed events use declaration merging and merge-extensible maps. Event JSDoc includes `@mode` and payload `@param`; scoped keys absent from payloads use `@dshScopeScan unsupported`.
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
- Product- or model-visible behavior changes require a real runnable, keyless snapshot in addition to focused tests ([testing policy](docs/testing.md)).
- Comments and docs state current contracts, not code restatement, review history, or reasoning transcripts. Code changes update affected README and JSDoc contracts; documentation follows [docs/AGENTS.md](docs/AGENTS.md).
- Files end with one trailing newline. TODO markers use `FIXME`, `TODO`, and `XXX` in decreasing urgency ([semantics](docs/development.md#todo-markers)).

Read [defensive patterns](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work. Read [testing policy](docs/testing.md) before designing coverage. Do not edit `vendor/` directly; follow [vendor/README.md](vendor/README.md).

## Agent skills

### Issue tracker

Issues and specs use [GitHub Issues](docs/agents/issue-tracker.md).

### Triage labels

Triage uses [canonical state labels](docs/agents/triage-labels.md).

### Domain docs

Terminology and ADR lookup use [multi-context domain docs](docs/agents/domain.md).

`CLAUDE.md` symlinks this file; edit `AGENTS.md`.
