# Agent Note: Decoupling 1/10 — the independent desktop workspace boundary

Status: proposed

English | [中文](2026-08-20-desktop-workspace-decoupling.zh.md)

## Problem

The repository combined the complete DeepSeek Harness monorepo with the Electron desktop product: `apps/desktop` depended on the workspace graph, packaging called repository-level build and closure tooling, the desktop carrier changed shared client packages for a no-WebServer runtime, and native UI work spanned many upstream UI packages. Upstream synchronization therefore carried a large, mixed-purpose conflict surface and kept the desktop product coupled to the source layout and release process of the official repository. The product needs to become an independently developed and released desktop application that still obtains its agent, model, tool, session, persistence, and plugin capabilities from an exact official DSH runtime ([parent decision](../../implemented/process/2026-08-16-desktop-fork-identity-and-upstream-readme-preservation.md) preserves the fork identity; the [desktop application proposal](../feature/2026-08-14-electron-desktop-app.md) describes the pre-decoupling architecture).

The migration proceeds in ten independently verifiable stages; this note owns stage 1, which creates boundaries and verification only. It does not migrate runtime, IPC, native behavior, or UI implementation, and it includes no unrelated cleanup or product feature.

## Proposal

Treat the decoupling branch as a new product workspace while retaining repository history. The repository root becomes the desktop product workspace; the legacy monorepo source is frozen in place under `legacy/`; the exact official DeepSeek Harness source is pinned as a root-level `upstream/` submodule for inspection and compatibility work only; and the product's agent-development resources (skills, Agent Notes, AGENTS.md rules) are migrated with the same care as the code boundary.

### Repository layout

- Root workspace: `pnpm-workspace.yaml` declares only `apps/*` and `packages/*`. The `legacy/` tree is deliberately not a workspace member, so ordinary install, typecheck, test, build, and packaging never read the legacy package graph.
- `legacy/` holds the frozen monorepo: its own `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `AGENTS.md`, `.agents/`, `.github/`, `docs/`, `packages/`, `apps/`, `vendor/`, and every other pre-decoupling root file. It is preserved for comparison and recovery until the decoupling removes it; the `legacy` branch is its recovery home. Never edit, build, or depend on it from the product workspace.
- `upstream/` is a submodule pinned to commit `141eb6fef83422698aef7a981029e843e8161534` (`dsh-v0.1.0-rc.8` on `deepseek-ai/deepseek-harness`), declared in `.gitmodules` with a gitlink in the index. It supports source inspection, compatibility comparison, and upgrade work; ordinary development never requires it, and the runtime assembly (stage 2) consumes exact published packages, not this submodule.
- Visual assets keep their content, names, and locations: `assets/readme/*` stays at the root (the README references it), and the application icon stays at `apps/desktop/build/icon.{png,svg}` inside the new shell package.

### Package roles

Five packages declare the product roles under the `@dsh-desktop/*` namespace; no desktop-owned package uses the official `@deepseek-ai/*` namespace:

- `apps/desktop` → `@dsh-desktop/shell`: Electron shell — windows, preload, context isolation, renderer Node restrictions, application lifecycle, DSH child-process supervision, native macOS handoff, and packaging. It owns no DSH sessions, tools, persistence, model execution, PTYs, or Cordis composition.
- `packages/bundle` → `@dsh-desktop/bundle`: desktop bundle and profile bootstrap — composes the `desktop` profile over the official base and Web bundles and repairs product-owned profile entries (stage 3).
- `packages/connection` → `@dsh-desktop/connection`: the IPC connection provider implementing the existing Client/Host connection contracts over a validated preload bridge (stage 4).
- `packages/native` → `@dsh-desktop/native`: native capability providers — directory selection, path opening, and similar macOS actions as Cordis providers with reverse requests (stage 6).
- `packages/ui` → `@dsh-desktop/ui`: UI contributions through documented client extension points (stages 7–8).

Dependency directions: desktop-to-desktop dependencies use `workspace:*`; dependencies on official packages (`@deepseek-ai/*`) and on third-party packages are exact published versions — never `workspace:` protocol, `file:`/`link:` references, or anything resolved through `legacy/`. Nothing outside `@dsh-desktop/*` may depend on a desktop package. Every capability enters through a Cordis plugin and a declared capability seam; the Electron shell is a host boundary, never a second agent runtime — **everything in the DSH product assembly remains plugin-composed**.

### Agent-development resources

- Skills: all fourteen non-`dsh-` skills are preserved (`code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `implement`, `prototype`, `record-browser-gif`, `setup-matt-pocock-skills`, `tdd`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, `writing-for-agents`). Seven `dsh-` skills are retained deliberately — `dsh-archive-agent-notes`, `dsh-code-review`, `dsh-find-simplifications`, `dsh-merging-stacked-prs`, `dsh-pre-push-checks`, `dsh-prose-standard`, `dsh-trim-cot-leakage` — with their repository references updated. Three are not copied: `dsh-doc-site-sync` (the documentation site is legacy), `dsh-doc-standards` (its budget and gate machinery is legacy; editorial judgment is covered by the retained prose skills), and `dsh-translate-docs` (its i18n corpus machinery is legacy; the pairing rule lives in the Agent Notes README).
- Agent Notes: the lifecycle tree (`proposed/`, `implemented/`, `rejected/`, `archived/`) and its rules are preserved. Eleven notes whose decisions still guide the desktop product are migrated with lifecycle status intact and references updated; the rest of the decision corpus stays frozen under `legacy/.agents/notes/`.
- Rules: the root `AGENTS.md` and `packages/AGENTS.md` are rewritten for the product; `CLAUDE.md` symlinks the root file. `docs/agents/` keeps the issue-tracker, triage-labels, and domain documentation for this fork.
- Verification: the repository-layout test (`tests/repository-layout.test.ts`) pins package ownership, dependency directions, the submodule declaration and pin, the retained skill set, the notes lifecycle tree, and the visual-asset locations. A minimal CI workflow runs frozen install plus typecheck, lint, and the test suite on pull requests.

## Alternatives considered

**Keep the legacy monorepo at the root and build the new workspace in a subdirectory.** The legacy code would stay fully intact, but the repository root would remain the monorepo, the future default branch would still present the official layout, and the pinned `upstream/` submodule would sit outside the product project. This contradicts "treat the desktop branch as a new product workspace" and leaves the stage-9 removal as a root-level rewrite instead of a scoped delete.

**Keep the legacy tree at the root but replace the root manifests with the new workspace.** The frozen copy would lose its own `package.json`/`pnpm-workspace.yaml`/lockfile coherence and interleave two projects at one root, making install and tooling boundaries ambiguous.

**Delete the monorepo source from the branch immediately.** The `legacy` branch preserves history, but stages 2–8 still port behavior from the old implementation; keeping the frozen copy on the branch until stage 9 preserves comparison access and makes the eventual removal a single scoped deletion.

**Copy every `dsh-` skill and every Agent Note verbatim.** Copying dead machinery as current contract is exactly what the migration rules reject: the dropped skills' mechanisms live in `legacy/`, and the retained set is selected deliberately and documented.

## Acceptance criteria

- The independent workspace declares the Electron shell and the four desktop-owned plugin/provider roles without introducing desktop-owned packages under the official namespace.
- The repository-layout test verifies package ownership, allowed dependency directions, the official submodule declaration and pin, and the required agent-development resources.
- All non-`dsh-` skills are preserved; the retained `dsh-` skills and the applicable `AGENTS.md` rules are selected deliberately rather than copied blindly.
- This proposed note records the new-project boundary, alternatives, acceptance criteria, risks, and the rule that everything in the DSH product assembly remains plugin-composed.
- Existing README images, screenshots, application icons, and other visual assets retain their existing content, names, and locations.
- The layout test, frozen install, typecheck, and lint pass, with exact commands and results recorded in the handoff.
- No unrelated cleanup or product feature is included.

## Risks

- **Parallel worktree drift:** stages 2–8 run in parallel worktrees based on this baseline. The layout test pins the boundary so a component slice cannot silently re-introduce `workspace:` links into `legacy/` or move a desktop package into the official namespace.
- **Lockfile churn:** each slice adds real dependencies; the combined lockfile is regenerated once by the tracer-bullet integration (stage 5). Slices avoid touching shared lock state beyond their own manifests.
- **Reference drift in migrated resources:** skills and notes now point into `legacy/` for frozen material. The layout test pins the skill set and lifecycle tree, and migrated notes' links were checked at migration time; a later slice owns a link verifier.
- **Frozen-copy confusion:** developers may mistake `legacy/` for a build input. The rules state the boundary in `AGENTS.md` and the packages rules, and stage 9's closure verification rejects any `legacy/`-sourced dependency.
- **Deferred machinery:** note-format, archive, pairing, and doc gates are not ported; the layout test provides the stage-1 checks and the automated gates return with later slices.
