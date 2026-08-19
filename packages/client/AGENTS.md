# AGENTS.md — Web client

Rules for `packages/client/*` and `apps/web`. Before changing slots, props, stores, or plugin structure, read the [slot model](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) and [client architecture](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md). Package roles live in [README.md](README.md).

## Composition and state

- Compose UI only through `ctx.slots.register`. A registration's `children` declares and authorizes every slot it renders; slot names follow the composition path.
- Derive component props from runtime, child-slot, store, and inject shares. Components never receive `ctx`, import services to reach it, read React context, or hand-write framework-derived props.
- Render-time mutable external data arrives through framework-provided hooks. Business components contain no subscription machinery or mirrored external snapshots.
- Parent-known data uses owner props; component-private data uses local state; shared or remount-surviving interaction state uses a registered store. Business Session, frame, and connection state stays in the object layer.
- Stores are factories registered from `apply`; components read `useStore` and write declared `actions`. Injected values are JSON-compatible data and callbacks; only the reserved hooks compartment carries observables.
- UI domains exchange JSON-compatible data and callbacks. Route React nodes through slots.

## Layering and exports

- `runtime` owns React-free business objects and observable sources; `web-react` owns ctx-to-React binding; feature packages own prop-driven presentation. Preserve this direction.
- Client plugin entry points export only Cordis loading values, shared types, and store factories needed for typing. Tests import internals directly. Cross-plugin behavior composes through slots or services, not convenience exports.
- Conversation features register a `ConversationNodeDefinition` and keyed renderer. Matching reads one event; updates fold deterministically; append and render hot paths never rescan full history. Follow the [cookbook](../../docs/cookbook/adding-a-conversation-node.md).
- One UI feature is one plugin package. Multi-domain packages expose a small shared contract, keep sibling domains independent, and centralize assembly in `apply`.

## Presentation and verification

Follow [web styling](../../docs/web-styling.md): CSS Modules, semantic theme tokens, visible focus, reduced motion, Chinese product copy, and English comments.

Component tests assert visible behavior through realistic props or the fixture runtime. Data semantics belong to runtime and Host tests. Run `pnpm run test:gui` for GUI code; changes to assembled browser behavior or visible output also run `DSH_SNAPSHOT=replay pnpm run test:web`. Use [dsh-pre-push-checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md) before publishing.

<<<<<<< HEAD
When adding a package or component, derive its current manifest, aggregate, bundle, slot, and test requirements from the linked architecture, cookbook, and neighboring owner files; do not maintain another setup checklist here.
=======
## Export discipline (client plugin packages)

The `/client` entrypoint of a UI plugin package is its public browser API, not a convenience barrel. Three rules apply package-wide (do not restate them as per-file comments):

1. **A UI plugin exports no values beyond what cordis loading needs** — `apply` / `inject` (and `Config` where present), plus store factories consumed type-only by components (`ReturnType<typeof createXXXStore>`). Shared types (owner data, injected values, composed prop aliases) may also be exported. Implementation components, pure helpers, constants, and store handles stay internal. Adding any new value export requires user sign-off, not a matching consumer.
2. **Same-package tests import internals directly** — relative `../src/client/xxx.ts` from package tests, or the `./src/*` subpath where a spec lives outside the package. Never widen the public API to make a test compile.
3. **Cross-package imports of another plugin's symbols are in principle forbidden.** The sanctioned routes are the slot system (register/renderSlot) and ctx services. If neither fits, stop and escalate — do not add an export to unblock yourself.

## ctx discipline (components never see ctx)

`ctx` belongs to the apply world only: the plugin body and the inject factories closed over it. Components — every `.tsx` under a feature domain — receive all data and callbacks **through the four props shares**; they never call a hook that reaches ctx, never import a service class to poke it, never read a React context (business components see zero contexts — `BindingContext` and its kin are renderer-internal). If a component needs something new, the answer is a prop threaded from its share's source (owner site, store declaration, or inject face), not a hook.

## Layering red lines

The stack has one-way knowledge, settled in the [web client architecture note](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md):

1. **Data object layer** (`runtime`, React-free): `ConnectionController` → `SessionManager` → `Session` own all business state (event windows, streaming accumulation, reconnect machine), and the snapshot-store engine (zustand/immer, `defineStore`, `shallowEqual`) lives here too — store products are bare observable sources with no hook members. Zero React imports — grep-assertable.
2. **Render machinery** (`ui-renderer`, dynamic plugin): all ctx-to-React integration — slot renderer/outlets, `SessionProvider`, and the uSES adapter. Every hook is composed here at the binding site from bare sources; production business code carries no ui-renderer value dependency.
3. **Presentation components** (plugin packages' `src/client/`, pure props): consumables, expected to be rewritten wholesale. Business logic must not leak into them; everything arrives through the four props shares.

Non-negotiables across the layers:

- **Business data lives in the object layer, never a store.** Entry-declared stores carry shared viewing/interaction state (selection, drafts, panel widths); sessions, frames, and connections stay in the object layer.
- **rpcId is strictly bidirectional**: the initiator mints, the responder echoes; business signatures see only `RpcRequest<P>`, minting stays in the carrier layer ([layering and RPC protocol note](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)).
- **Notifier publication discipline**: `notifyNow` is only the direct echo of a user gesture; structural updates use microtask-batched `markDirty`, while visible streaming chunks use cumulative `markFrameDirty`. See `runtime/src/client/sessions/notifier.ts`.
- **The web layer is pure presentation.** Nothing that is "how to draw" (tool-card views, queue states) enters the session log; the host computes such data per frame or pushes it live, and replay recomputes it — falling back to the generic form when it can't. A new *model-visible* input still requires a session event (repo-wide rule).

## Dependency declaration

Npm sections describe installation and development relationships; each build face independently decides what its artifact contains. [`verify-client-packages`](../../scripts/verify-client-packages.ts) checks the client-specific rules and can repair unambiguous manifest drift with `--fix`.

1. **Every client package keeps Cordis in matching `peerDependencies` and `devDependencies`.** This includes the static packages because their Node face participates in the same Cordis plugin contract.
2. **A dynamic package declares internal dynamic relationships as peer plus dev.** Production source imports, re-exports, module augmentations, and type-only references to an `@deepseek-ai/dsh-*` package count, as does a package named by `dsh.client.inject`. A test-only internal dependency stays dev-only.
3. **Static client inputs are dev-only for a dynamic consumer.** A package without `dsh.client`, plus the React modules seeded by the web shell, belongs only in the consumer's `devDependencies`; it never belongs in that dynamic package's `dependencies` or `peerDependencies`. `packages/client/web` likewise keeps Loader, modules, and static UI inputs as development inputs; Cordis remains peer plus dev.
4. **Ordinary installed libraries stay in `dependencies`.** This includes private implementation libraries bundled into `lib/client.js` and bare imports left in a statically linked `lib/index.js`; the final Vite host, not the library build, merges and splits the latter. A dynamic package never puts an `@deepseek-ai/dsh-*` package in `dependencies`.
5. **Every peer has a matching development range.** npm dependency and peer cycles are allowed; only the synchronous module-request graph has the separate acyclicity rule below.
6. **Browser and Node build faces declare externality independently.** A dynamic browser half uses the baseline plus `dsh.client.external`; a statically linked face externalizes every bare specifier; a Node face externalizes its production dependencies ([`tsdown.client.ts`](tsdown.client.ts)). Moving a name between npm sections must not silently change bundle contents.
7. **Keep the published payload closed.** Every relative runtime import and emitted asset must be covered by `files`; the repository publint pass checks the exact publication view.

## Build-time browser environment

Client business code may statically read `process.env.DSH_CLIENT_*`; every referenced value is public artifact content. The shared build-environment helper gives Vite and dynamic tsdown bundles the same build-process values, resolves unset names to `undefined`, and exposes no dynamic lookup or enumeration. A complete root build records the exact public values and a digest of all client artifacts; release and built-artifact consumers reject a missing or stale record. Use runtime configuration for choices that must change after build.

## Shared modules and the module graph

A dynamic browser half either carries a module privately or requests the shared module-table identity. The client baseline is centralized in [`web/src/platform.ts`](web/src/platform.ts): `PLATFORM_MODULES` names shell-seeded React, Cordis, and static UI libraries; `PRELOADED_CLIENT_EXTERNALS` names dynamic rows, currently runtime, whose ordinary `lib/client.js` factory arrives before shell boot.

1. **Baseline externals are implicit for every dynamic bundle.** Do not repeat React, Cordis, runtime, `ui-primitives`, or `ui-slots` in package manifests.
2. **`dsh.client.external` adds a package-specific request.** Use it only for a non-baseline value import whose dynamic row must be materialized through the module table. Declare the exact import specifier; only a trailing `/client` aliases the package row.
3. **Silence means a private copy.** Ordinary third-party implementation libraries may be bundled independently. A value reached only through `import type` is erased and creates no request.
4. **A request has two possible suppliers.** A dynamic package supplies its own row; `PLATFORM_MODULES` supplies an exact static-table key. There is no `dsh.client.provide` alias protocol.
5. **Validate both sides.** The dynamic build preset externalizes the baseline and rejects undeclared workspace value imports; [`verify-client-packages`](../../scripts/verify-client-packages.ts) rejects malformed or redundant requests, missing suppliers, and synchronous request cycles.

### The module graph sits below cordis DI

Three declarations read like dependency edges and none is interchangeable: Cordis service `inject`, module-graph `external`, and `dsh.client.inject` — the informational package-name edges of the [new-package checklist](#new-plugin-package-checklist).

| | Cordis service `inject` | module graph `external` |
|---|---|---|
| Unit | service name | module specifier |
| Timing | runtime; the fiber waits | materialization; the `require` handed to a factory is synchronous and cannot wait |
| Unsatisfied | stays PENDING, with no timeout | throws on the spot |
| Who may satisfy it | any plugin providing that service, replaceable | the single module identity, not replaceable |
| Cycles | allowed | rejected |

The seam is `loader.internal = modules`: cordis reaches plugin code through `EntryTree.import`, so every module request must be satisfiable before cordis can order activation above it. The modules node half emits rows in topological order, and `ClientModuleSystem.import`/`prefetch` recursively registers dynamic provider factories before their consumers materialize. This module order is independent from Cordis activation: a provider that injects services can register first and activate last.

`packages/client/web` is not a Loader entry. Its static imports seed `PLATFORM_MODULES`; parser-preloaded dynamic rows remain ordinary Loader entries and ordinary `lib/client.js` artifacts.

## Conversation Node discipline

- A Chat business feature registers one `ConversationNodeDefinition` and its keyed `conversation.chat.node` renderer; do not add its event switch or fold to `Session`, `SessionManager`, or a central built-in dispatcher. Follow the [Conversation Node cookbook](../../docs/cookbook/adding-a-conversation-node.md).
- `match(event)` reads only the current event. Every event in a multi-event Context carries or independently derives the same stable business id; `update` folds one Match into State and remains deterministically replayable by log `seq`.
- The append hot path and renderers never scan the full event window, Contexts, or Chat Nodes. Accumulate in State, publish same-Turn/Step facts through `buildLocationData()`, and consume final Node data or constrained Location hooks.

## Directory regime (plugin packages)

One UI feature = one plugin package (`src/client/` browser half). A multi-domain package splits where its code could later become separate packages — ui-conversation is the example: `contract/` (the only shared API), domain directories that never import a sibling domain, and `apply.ts` as the single cross-domain assembly point; `scripts/verify-client-domain-graph.ts` enforces the levels. Registration goes through `slots.register` in `apply` — never module-level side effects.

## Styling

[docs/web-styling.md](../../docs/web-styling.md) is authoritative. Shared `--dsw-*` tokens and global sheets live in `ui-theme/src/styles/`; feature components consume semantic aliases through CSS Modules and `clsx`, with no literal colors, component library, or Tailwind. Product copy is Chinese; code comments are English.

## Testing and coverage

The GUI test structure (three tiers, lane map) is settled in the [GUI testing system note](../../.agents/notes/implemented/process/2026-07-20-gui-testing-system.md); repo-wide policy in [docs/testing.md](../../docs/testing.md).

- Client source packages are inside the per-file 100% coverage gate (`pnpm run test:coverage`). Genuinely unreachable defensive arms take a `/* v8 ignore -- <reason> */` comment with a real reason, never a bare ignore.
- Component specs render with realistic props or a driven fixture runtime and assert user-visible behavior, not class names, hook internals, or render counts.
- The jsdom environment comes from a per-file `// @vitest-environment jsdom` pragma on the spec's first line; the shared config stays node-env.
- Each tier asserts its own layer. Data-layer semantics belong to the runtime and host suites; component specs cover presentation behavior.

## Before you push: the local check ladder

Run the narrowest rung that covers what you touched; escalate only when the change surface demands it.

1. **Every GUI code change** — `pnpm run test:gui` (seconds; no browser, no server): the client suites plus the host-side GUI packages. This is the inner loop; run it as freely as a typecheck.
2. **Any change that can alter the assembled browser or visible conversation/UI output** (client components or copy, `apps/web`, Vite, `dsh-host-webserver`, connection/handler/SSE) — additionally `DSH_SNAPSHOT=replay pnpm run test:web`: rebuilds the frontend dist, then runs the browser smoke pair (the real-host case self-skips without `DEEPSEEK_API_KEY`) plus the keyless replayed e2e scenarios. Linux PR CI uses the same read-only replay mode. Use `DSH_SNAPSHOT=refresh` only after confirming an intentional output change, or `DSH_SNAPSHOT=record` with a key to re-record fixtures.
3. **Before a PR** — use [dsh-pre-push-checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md) to select the narrow checks for the outgoing diff; there is no repo-wide pre-push aggregate.

If `test:gui` is red on code you did not touch, neither silently fix nor ignore it: note it in your handoff so it lands in the next PR window's sweep.

## New plugin package checklist

Bringing up a new `packages/client/<name>` plugin package (ui-workspace is a complete example; ui-sidebar/ui-user-questions are minimal skeletons):

1. **Package skeleton**: `package.json` (`@deepseek-ai/dsh-client-<name>`, exports `.`/`./invariant`/`./client`/`./src/*`/`./package.json`, `dsh.client` manifest, `files` list), `tsconfig.json` (extends `tsconfig.base.client.json`, one `references` entry per workspace dependency plus `runtime-diagnostics/invariants`), `tsdown.config.ts` (`clientBundle(id, ['lib/types/index.js', 'lib/types/invariant.js'])`), `src/index.ts` (empty node-half apply), `src/invariant.ts` (companion with a real reason), `src/css-modules.d.ts` when using CSS Modules, `README.md` with the Model Experience section.
2. **Three registration surfaces, all required** (missing any one fails at a different, later point): the `tsconfig.client.json` aggregate `references` entry; a `dsh.client` row in `packages/bundle/web-app/cordis.patch.yml`; a `packages/bundle/web-app/package.json` dependency (profile boots resolve bare row names through the healed `$DSH_HOME/profiles/node_modules` fallback, which mirrors the app's and each bundle's declared dependencies — a row whose package no manifest declares fails to import). `pnpm-workspace.yaml` already globs `packages/*/*`.
3. **dsh.client manifest semantics**: `platform: 'web'` always, and the declaration requires a `./client` export (the scan throws without one); `immediately: true` only for stage-one-prefetch infrastructure rows. `inject` lists package-name dependency edges — they are **informational only** (preflight display, HMR diffing); they do not sequence entry activation or apply order. Activation order is Cordis fiber inject waiting on *services*, nothing else. A non-baseline `external` request sequences its dynamic supplier ahead of the consumer — see [shared modules](#shared-modules-and-the-module-graph).
4. **Registering into another package's slot**: apply order is unconstrained, and a business service is not a declaration barrier. Use `ctx.slots.inject(name, () => ctx.slots.register(...))`; it waits on the actual declaration, removes the contribution when that declaration collapses, reruns after redeclaration, and leaves with the caller's plugin fiber. Return a generator yielding each registration when several contributions must install and roll back atomically. A bare `slots.register` into an undeclared slot remains an error; keep service edges only for services the contribution actually reads.
5. Rebuild the bundle (`pnpm --filter <pkg> bundle`) before probing a live `dsh web` server — the registry serves `lib/client.js`, not sources.
6. **Declaration decisions**, each settled by [dependency declaration](#dependency-declaration) and [shared modules](#shared-modules-and-the-module-graph): does the package ship a `./client` export; which non-baseline value imports require `dsh.client.external`; which dynamic value dependencies are peer plus dev; which static compile inputs are dev-only; and whether `files` covers every relative runtime import and emitted asset.

## New component checklist

1. Compose through register: add the slot to `SlotMap`, declare it in its parent entry's `children`, and register your component — see the [slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md). No other composition route exists.
2. Type the props as the four shares (`PropsRuntime` & `PropsRenderSlots` & `PropsStore` & inject face) — derive, don't hand-write. Shared/surviving state goes in a `createXXXStore()` factory declared at register; component-private state stays local.
3. Component tests feed props directly (`createXXXStore().create()` for the store data; plain stubs for framework hooks) and assert behavior without render machinery.
4. Tokens only in CSS; Chinese product copy; English comments.
5. `pnpm run test:gui` green; if the component changes visible assembled output, also run `DSH_SNAPSHOT=replay pnpm run test:web`.
6. Non-trivial change? It needs an Agent Note in the same PR (repo-wide rule) — the GUI notes above are the precedents to extend.
>>>>>>> upstream/master
