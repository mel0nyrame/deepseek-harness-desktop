# @deepseek-ai/dsh-client-ui-sidebar

English | [中文](README.zh.md)

Sidebar shell plugin: the wordmark, New Session action, the layout-owned collapse toggle, scroll-aware region seat, and bottom-pinned Settings seat. [ui-workspace](../ui-workspace/README.md) owns the Workspace and Session browser rendered into `sidebar.workspaces`; this package neither derives its rows nor owns its view preferences. Collapse resolves to the layout-owned zero-width track: the shell unmounts at the crossfade settle and the frame's reveal control (owned by [ui-layout](../ui-layout/README.md), outside this subtree) takes over. Contract: the [slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md).

New Session starts the runtime's page-local frontend Session Intent. The runtime targets the explicit Workspace used by a scoped action, otherwise the current Session's Workspace, otherwise the most recently active Workspace; when none exists it clears into the blank New Session page. Workspace-specific controls and the shared picker belong to ui-workspace.

`SidebarRootComponentProps` composes the layout owner share, the global `useSessions` and `useWorkspaces` hooks, the declared `sidebar.workspaces` and `sidebar.settings` child slots, and injected `startSession` plus sidebar-toggle callbacks. There is no plugin store.

During a live collapse, the shell holds the expanded content at its current width (inline style) while it fades out for 150ms; the layout's 300ms column slide clips it to the zero-width track, and at the settle the shell unmounts entirely — no compact rail remains. A page that starts collapsed renders nothing (the frame's reveal control is the only affordance), and reduced-motion mode disables the transitions. Expanding remounts the wide content with the 200ms wide-in fade.

Scrollbars in the column are a pointer affordance: the shell rebinds ui-theme's [scrollbar indirection](../ui-theme/README.md) to `transparent` whenever the pointer is outside it, and keeps the thumb drawn for 2s after the pointer leaves, so a list nobody is pointing at carries no bar. The reservation that keeps rows from moving belongs to the scrolling region ([ui-workspace](../ui-workspace/README.md)), so revealing a thumb never reflows.

The foot contains the bottom-pinned `sidebar.footer.action` and `sidebar.settings` seats. Their owner shares are empty because the seats exist only while the expanded shell is mounted; ui-cordis and ui-settings-general register their respective trigger rows and panels there.

The `/client` exports are the plugin body (`apply`/`inject`) plus the contract types only; SidebarRoot, the row components, and the tree derivation remain package-internal behind the slot registration.

## Model Experience

None, as the sidebar renders the browser session list; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Session state-dot rendering is owned by [ui-workspace](../ui-workspace/README.md)** — no done/error notification sources are available.
- **Workspace browser behavior is composition-owned** — grouping, ordering, search, and row state belong to [ui-workspace](../ui-workspace/README.md), not this shell.
- **"New task completed" unread marking is local viewing state** — completion-time > last-seen never reaches the host.
