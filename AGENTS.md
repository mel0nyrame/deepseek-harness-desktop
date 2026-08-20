# AGENTS.md

DeepSeek Harness Desktop (`deepseek-harness-desktop`) is a pnpm-workspace,
plugin-composed Electron desktop product. **Everything in the DSH product
assembly remains plugin-composed**: the desktop profile composes the exact
published DeepSeek Harness runtime with desktop-owned Cordis plugins, and the
Electron shell is a host boundary, never a second agent runtime. Before
changing `packages/`, read [`packages/AGENTS.md`](packages/AGENTS.md).

## Pre-release stance: foundation over blast radius

Remove at the first tagged release. Prefer foundations over compatibility
shims; rename or repackage and update every reference. The product is
pre-release: no user-data migration is owed, and the `desktop` profile is the
single product identity.

## Repository structure

- The product workspace lives at the repository root: `apps/desktop` (the
  Electron shell, `@dsh-desktop/shell`) and `packages/*` (`@dsh-desktop/bundle`,
  `connection`, `native`, `ui`).
- [`legacy/`](legacy/README.md) is the frozen official monorepo source,
  preserved for comparison and recovery until the decoupling removes it.
  Never edit, build, or depend on it; the `legacy` branch is its recovery
  home.
- [`upstream/`](upstream) is the pinned official DeepSeek Harness source
  submodule, for source inspection and compatibility work only. Ordinary
  install, typecheck, test, build, and packaging never require it.
- `assets/readme/*` and `apps/desktop/build/icon.*` are product identity:
  content, names, and locations are preserved; never rename, move, or replace
  them.

## Commands

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run test:layout   # repository-layout boundary test
pnpm run check         # typecheck + lint + test
```

Real-API tests and demos read `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`,
and root `.env`; never commit credentials. Official runtime packages are
consumed as exact published versions, never from `legacy/` or `upstream/`.

## Conventions

- Desktop packages are `@dsh-desktop/<role>`; official runtime packages keep
  `@deepseek-ai/*`. Desktop-to-desktop dependencies use `workspace:*`;
  everything else is an exact version. Nothing outside the workspace may
  depend on a desktop package, and the workspace never reads the `legacy/`
  package graph.
- Registrations are effects through `ctx.effect()` or `ctx.on()`; registry
  `register()` methods return disposers. Waterfall listeners call `next()` to
  delegate.
- Anything model-visible is reconstructable from the session log. Add a
  session event for each new model-visible input.
- Extend through documented plugin points and capability seams (Service
  Definition, Provider, Consumer). Desktop capabilities are Cordis providers,
  not renderer backdoors; the shell owns no agent runtime.
- Resolve defaults explicitly in the owning implementation before execution.
  Deployment tunables are validated `Config` fields; protocol, external-spec,
  and security constants remain fixed.
- Trust TypeScript inside typed same-process calls. Validate parser/config,
  model/tool JSON, durable/file, worker, process, and wire inputs.
- Tests describe behavior, not correctness. Visible behavior needs a real
  keyless snapshot plus focused tests. Change obsolete behavior with its
  tests and explain why in the PR.
- TypeScript stays strict. Public function-like exports use concise JSDoc.
  Files end with one trailing newline. TODO markers use `FIXME`, `TODO`, and
  `XXX` in decreasing urgency.

## Agent Notes and skills

Every non-trivial change adds or updates an [Agent Note](.agents/notes/README.md).
Notes keep their proposed/implemented/rejected/archived lifecycle and the
bilingual triplet convention; never edit archived content. All non-`dsh-`
skills are preserved in [`.agents/skills/`](.agents/skills/), and the retained
`dsh-` skills are the deliberately selected set (see the workspace-decoupling
Agent Note). The `.agents/notes/` and skills trees are agent-development
resources; the repository-layout test pins them.

## Agent resources

Issues/specs use [GitHub Issues](docs/agents/issue-tracker.md); triage uses
[canonical labels](docs/agents/triage-labels.md); terminology and ADRs use
[domain docs](docs/agents/domain.md).

`CLAUDE.md` symlinks this file. Read [defensive
patterns](legacy/docs/defensive-patterns.md) before lifecycle, concurrency,
subprocess, or teardown work in the official runtime layers.
