# Main promotion: parity evidence, real-API acceptance, and checklist

English | [中文](promotion.zh.md)

This document is the promotion record for decoupling issue #72: the reviewed pull request that completes the decoupled desktop product and takes over the repository default branch through a normal merge. It records the staged CI design, the final keyless behavior-parity evidence with exact results, the protected manual real-API acceptance procedure, and the promotion checklist. It does not merge the promotion PR, publish a release, or rewrite history. The rationale for the staged tiers lives in the [staged-CI Agent Note](../../.agents/notes/implemented/process/2026-09-02-staged-ci-and-main-promotion.md).

## Staged CI

| Tier | Workflow | Runs when | Credentials |
| --- | --- | --- | --- |
| Ordinary PR | `ci.yml` | every pull request and push | none |
| Packaging | `packaging.yml` | pull requests that change app-artifact inputs (`apps/**`, `packages/**`, `runtime/**`, `scripts/**`, `patches/**`, `tests/fixtures/**`, lockfiles, the workflow itself); every `master` push; manual dispatch | none (ad-hoc) |
| Release | `release.yml` | pull requests labeled `release` (ad-hoc preview); `v*` tags and manual dispatches (signed, notarized) | signed tier only, via Actions secrets |

`tests/ci-staging.test.ts` pins the tier contract in the ordinary suite. The signed release tier requires six repository secrets — `MAC_SIGNING_IDENTITY`, `MAC_CERTIFICATE_P12`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — and its guard step fails the job when any is missing; a tag build never silently ships ad-hoc. The workflow never publishes a GitHub release; it uploads per-architecture artifacts, SHA-256 checksums, and the packaging log as evidence.

## Behavior-parity evidence (keyless)

All evidence comes from the keyless suites: the real Electron shell, the real bundled DSH child, real bash/PTY tools, and replayed model turns — no model API key anywhere. Recorded on macOS 26.6.2 arm64 with Node 26.8.1 and pnpm 11.7.0, Electron 43.4.0, on the promotion-PR branch.

| Surface | Evidence |
| --- | --- |
| Light / Dark | `tests/desktop-ui-visual.e2e.test.ts` is a synthetic contribution smoke test for `glass-light` and `glass-dark`, not a visual-parity authority; `tests/desktop-native-window.test.ts` derives renderer appearance from native state and validates the theme bridge (`light`, `dark`) |
| System | `tests/desktop-native-window.test.ts` accepts the `auto` theme preference and republishes native `nativeTheme` updates to the renderer |
| Reduce Transparency | `tests/desktop-ui-visual.e2e.test.ts` renders the opaque accessibility fallback (`transparency: opaque`, material `opaque`) |
| Window chrome and drag | `tests/desktop-native-window.test.ts` pins the compact macOS chrome; the installed-app journey records semantic and resolved-geometry facts for the real `data-desktop-window-chrome` region beside product captures |
| Sidebar | `tests/desktop-sidebar-integration.test.ts` retains official labels, workspace counts, slots, and toggle interaction; `tests/desktop-runtime.e2e.test.ts` is the real-product visual-acceptance journey, while the synthetic smoke covers isolated collapsed and revealed contribution states only |
| Conversation streaming | `tests/desktop-runtime.e2e.test.ts` renders one ordered keyless terminal turn over the real embedded DSH child; its published-Client journey creates three fixed non-blank reference sessions through supported Host APIs, then captures streaming, complete, and replay-exhaustion states in a supplemental session |
| Tools | the terminal journey and published-Client journey both assert the bash-backed result is visible; the latter prints `TRACER_OK official-client-ui` after the reference and supplemental replay scripts are consumed |
| Terminal / PTY | the real bash/PTY path runs in both source and installed-product journeys; `tests/desktop-process-tree.e2e.test.ts` covers real PTY cleanup in five process scenarios |
| Workspace / directory selection | `tests/desktop-runtime.e2e.test.ts` adopts a directory and opens a path through the full native reverse-request journey; the installed journey captures the workspace picker, adopts the picked directory, and records `workspacePath`/`workspaceLabel` |
| Settings | `tests/desktop-runtime.e2e.test.ts` composes the settings contribution; the installed journey opens the real settings dialog, toggles the desktop glass setting, and verifies the durable projection in `settings.yaml` (`ui-sidebar-glass-macos: enabled: false`) |
| Restart / session behavior | `tests/desktop-supervisor.test.ts` pins readiness, unexpected exit, and exactly one controlled restart; `tests/desktop-runtime.e2e.test.ts` restarts once after a configuration failure; the installed smoke joins the embedded child when the shell quits during startup |
| Clean shutdown | `DSH_DESKTOP_PROCESS_EVIDENCE=1` journeys record every owned PID and assert none survives Electron exit; the runtime tree digest is unchanged across the smoke; five real-process cleanup scenarios run in `tests/desktop-process-tree.e2e.test.ts` |

### Exact recorded results

| Command | Result |
| --- | --- |
| `pnpm run check` | typecheck pass; oxlint 0 warnings, 0 errors (76 files); vitest 30 files, 176 passed + 1 skipped (177 tests), 50.87 s |
| `pnpm run package` | products `DSH Desktop-0.1.0-arm64.dmg` (+`.blockmap`) and `mac-arm64/DSH Desktop.app`; signature `adhoc`; Gatekeeper assessment recorded: rejected (expected for ad-hoc); runtime closure, native ABI, and identity evidence pass |
| `DSH_DESKTOP_PACKAGE_REQUIRED=1 pnpm run test:package` | 2 files, 10 tests passed, 40.88 s — installed app runs outside the source tree under the network guard with zero surviving owned processes |
| `shasum -a 256 'apps/desktop/dist/DSH Desktop-0.1.0-arm64.dmg'` | `d542664356e2886b1f3e8dfda8d4b3b2b3b63b6eb35221d7e2dfdc10eb12dd6a` |
| [Release preview arm64](https://github.com/mel0nyrame/deepseek-harness-desktop/actions/runs/33586031825/job/100110253298) | Native `macos-15` build passed; installed-product gate 2 files / 10 tests passed; DMG checksum `a041f691cadaef20b52eaeecbc05a41490ef1d27c9d1438324ca4c9984f4f8d4` |
| [Release preview x64](https://github.com/mel0nyrame/deepseek-harness-desktop/actions/runs/33586031825/job/100110253117) | Native `macos-15-intel` build passed; installed-product gate 2 files / 10 tests passed; DMG checksum `696e9d47b832d014684c89d864810de25594013cad438dcab8dd599045521e6d` |

## Protected manual real-API acceptance

The keyless suites above prove the carrier, shell, and tool paths without model credentials. One real model turn must be accepted manually before a tagged release; the key stays local and never enters CI (no workflow references `DEEPSEEK_API_KEY` — pinned by `tests/ci-staging.test.ts`).

1. Put the key in the gitignored root `.env` (`DEEPSEEK_API_KEY=…`, optional `DEEPSEEK_BASE_URL`).
2. Launch the packaged application with that environment:
   ```sh
   set -a; source .env; set +a
   "apps/desktop/dist/mac-arm64/DSH Desktop.app/Contents/MacOS/DSH Desktop"
   ```
3. Pick a workspace, create a session, send one real prompt, run one terminal-backed turn, and confirm ordered streaming output and a clean quit.
4. Copy the acceptance evidence (window screenshots and the session transcript under `~/.dsh`) into `.artifacts/real-api-acceptance/` — gitignored, local-only — and record the date, artifact version, and model used in this document's promotion PR.

Never commit the key, quote it in evidence, or pass it through a workflow environment.

## Promotion checklist

- **`legacy` branch** — `origin/legacy` at `0971b9f0e3` retains the frozen pre-decoupling monorepo under `legacy/`; `tests/repository-layout.test.ts` rejects any tracked `legacy/` path and pins the same snapshot commit.
- **Migration baseline tag** — `migration-baseline` points at `0971b9f0e3` (the master commit the `legacy` branch was cut from); the pre-decoupling release tags `v0.1.0-rc.5` and `v1.0.0-rc.1` are ancestors of it.
- **Revert-based rollback** — the promotion PR merges as a normal merge commit; `git revert -m 1 <merge>` restores the prior default-branch state without force-push. Nothing in the promotion rewrites history.
- **Exact runtime manifest** — `runtime/runtime-manifest.json` pins `@deepseek-ai/dsh` `0.1.0-rc.8`, upstream commit `141eb6fef83422698aef7a981029e843e8161534`, Electron `43.4.0`, `node-pty` `1.2.0-beta.15` (patched, pinned hash), `koffi` `3.1.0`, four versioned upstream patches, and the lockfile digest `9594e9b8b7a4e51af2d08d77d4083cfb526b65d2c301ff54250025598b2a03c3`.
- **No force-push requirement** — the promotion lands through a reviewed pull request into the existing default branch; neither promotion nor rollback needs a force-push.
- **Recorded results** — the exact command results above are attached to the promotion PR description; CI (workspace, packaging, and native arm64/x64 preview tiers) is green on the promotion head and must remain green on the promotion merge commit.
