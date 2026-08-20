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

When adding a package or component, derive its current manifest, aggregate, bundle, slot, and test requirements from the linked architecture, cookbook, and neighboring owner files; do not maintain another setup checklist here.
