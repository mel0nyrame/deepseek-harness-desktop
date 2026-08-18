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

<<<<<<< HEAD
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
=======
- Every npm package is `@deepseek-ai/dsh-<name>`; vendored packages are rescoped ([mapping](docs/rescope.md)) and `private: true`. `@deepseek-ai/cordis` is a peerDependency (+ dev) of every harness package.
- ESM everywhere (`"type": "module"`). Use package names across packages and `.ts` in local relative imports. Config subprocesses run built `lib/` under plain Node; source regressions use their declared launcher ([testing policy](docs/testing.md#test-subprocess-launch-modes)). The `dsh` CLI source launch runs through tsx's ESM-only hook (`node --import tsx/esm`); modules it reaches must stay ESM (no CJS-only exports) — Node's native TypeScript modes are unavailable across the engines range ([source-launch contract](.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md)). Raw/Web `cordis.yml` bare plugins must appear in their resolver manifest's `dependencies`; `verify-cordis-config` enforces it.
- **Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer.
- **Runtime invariants assert owned relationships.** Check authoritative event streams or mutable data, not service or method presence, plugin metadata or effects, or fixed pure examples. Without a plausible relationship, an explained empty companion is correct ([package invariant rules](packages/AGENTS.md)).
- **Typed events use declaration merging** and merge-extensible maps. Event JSDoc needs `@mode` and payload `@param`; scoped keys absent from payloads need `@dshScopeScan unsupported`. Public service methods document parameters and non-void returns. A `SessionEventMap` member is required-on-read by default — builds that do not know its type refuse the log unless the event carries the envelope's `ignorable: true`; only structural format changes bump `SESSION_FORMAT_VERSION` ([mechanism](.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md)).
- **Switch on discriminant tags.** Closed unions end in `assertNever`; merge-extensible unions fall through a documented default.
- **Waterfall listeners MUST call `next()`** to delegate; returning without it short-circuits the chain ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event.
- **Plugins, not loop changes**: new behavior goes on documented extension points; changing `agent-loop` requires updating docs/architecture.md.
- **A capability seam comprises Service Definition / Service Provider / Consumer roles.** It is complete, never one role; split only when roles evolve independently ([glossary](docs/glossary.md#capability-seam)).
- **Prefer maintained dependencies over hand-rolling** when they genuinely delete owned code and tests ([policy](.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md)).
- **Explicit > implicit at package boundaries**: defaulting is an explicit `resolve(request): Spec` step in the owning implementation, never a hidden `?? default` inside `run()` (the `dsh-shell` request/spec split is the template).
- **No hardcoded tunables in plugins**: deployment-varying choices are validated `Config` fields changeable from cordis.yml; a `DEFAULT_*` constant or test hook is not configurability. Protocol constants, external specs, and security invariants stay fixed.
- **Misconfiguration fails loud** at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent.
- **Opaque cross-boundary ids are branded** (`Branded<B>` from `dsh-brand`), never bare `string`.
- **Trust TypeScript at typed same-process boundaries.** Do not add runtime validation, fallback behavior, or hostile-input tests solely for values the static interface requires; validate at parser/config, queued, model/tool JSON, durable/file, worker, process, and wire boundaries.
- **Source plane vs artifact plane, never mixed.** Static gates and tests resolve workspace imports through tsconfig `paths` to `src` and pass on a clean tree; gates consuming built `lib/` declare that dependency ([layout](docs/development.md#typescript-project-layout)).
- **Keep compiler faces explicit.** Each package uses one aggregate except `api/remotes`; repo-wide programs seed a face config, never the root solution ([layout](docs/development.md#typescript-project-layout)).
- **An empty `catch` names what it swallows** and why nothing else can reach it; keep the `try` to one statement.
- Do not comment on facts obvious from code.
- **Prefer symmetry for parallel values**; unexplained asymmetry usually signals a missed extraction.
- **Tests describe behavior, not correctness.** Change obsolete behavior with its tests; explain why in the PR.
- **Non-trivial changes MUST include an Agent Note in the same PR;** only mechanical/local edits are exempt ([scope](.agents/notes/README.md#when-to-write-one)). Archived notes are frozen: never edit or treat them as current authority ([archive policy](.agents/notes/README.md#archiving-and-deletion)).
- **Testing policy** — [docs/testing.md](docs/testing.md). Every non-trivial model- or product-user-visible behavior change adds or updates a keyless snapshot through a real runnable example in the same PR; package tests, e2e-only assertions, and mock-only fixtures do not substitute for the assembled application transcript. Fixtures must replay on macOS/Linux; fix fixtures, not normalizers.
- **A tool's UI render intent is part of its design**, decided up front (`generic`/`terminal`/`diff`, `locations`); presentation methods are pure functions of `args` ([cookbook](docs/cookbook/adding-a-tool.md)).
- **Plan unit, e2e, and snapshot coverage** for capability seams, lifecycle paths, and transcript output; include missing snapshot-harness support in the same change.
- **Both SDKs project the loop.** Agent-loop, session-lifecycle, and `SessionEventMap` changes update the TypeScript and Python SDK expected outputs in the same PR; `pnpm run test` covers neither ([surfaces](docs/testing.md#when-a-snapshot-test-is-required)).
- **Choose PR history deliberately.** Split independent changes; fix the introducing PR before propagation. Standalone PRs and official stacks may merge-forward or rebase after review. Rewrites use `--force-with-lease`, abort on remote movement, never raw `--force`; an in-progress merge-forward preserves its checkpoint before taking a newer base ([rationale](.agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.md)).
- **Labels:** one PR `kind/*`, all material `area/*`, and native Issue Type ([taxonomy](.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md)).
- TODO markers: `FIXME`/`TODO`/`XXX` by urgency ([semantics](docs/development.md)).
- Files end with exactly one trailing newline; `git diff --cached --check` (pre-commit) gates it.
>>>>>>> upstream/master

Read [defensive patterns](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work. Read [testing policy](docs/testing.md) before designing coverage. Do not edit `vendor/` directly; follow [vendor/README.md](vendor/README.md).

## Agent skills

### Issue tracker

Issues and specs use [GitHub Issues](docs/agents/issue-tracker.md).

### Triage labels

Triage uses [canonical state labels](docs/agents/triage-labels.md).

### Domain docs

Terminology and ADR lookup use [multi-context domain docs](docs/agents/domain.md).

`CLAUDE.md` symlinks this file; edit `AGENTS.md`.
