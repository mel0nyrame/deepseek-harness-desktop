# @deepseek-ai/dsh-client-ui-directory-picker-native

English | [中文](README.zh.md)

Native directory-picker client surface. It fills ui-workspace's two directory-flow holes (`conversation.hero.workspace.directoryFlow` and `sidebar.workspaces.directoryFlow`) with a renderless occupant that answers each `open` request through `ctx.workspaces.pickDirectory()`, then reports exactly one outcome — a picked path, a cancellation, or a failure — back through the owner conversation. The composed Host capability owns the actual chooser: ordinary local Web deployments may use [`dsh-host-directory-picker-native`](../../host/directory-picker-native/README.md), while the Electron desktop product provides the same capability through its typed reverse request. Client code does not branch on the provider.

Both registrations install as one transactional effect through nested `slots.inject()` calls, because either declaring entry may activate later or replace its declaration. The occupant arms once per rising `open` edge, so re-renders — including an adoption that keeps `open` true while `busy` — never launch a second chooser, and the owner withdrawing `open` re-arms the next request. Settlements ride a ref so the answer reaches the owner's latest handlers rather than the ones captured when the chooser opened. Unmount or owner withdrawal aborts the request and discards its settlement; an injected-face identity change alone keeps the current operation because it is still the same owner task.

The node half is an empty `apply`: it exists so the plugin appears in the host cordis.yml and Loader, while the browser half ships through `exports["./client"]` and is discovered through the `dsh.client` manifest declaration.

## Model Experience

None, as the directory chooser is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Physical dialog dismissal is provider-specific** — owner withdrawal aborts the wire request immediately and ignores any late settlement, but a provider whose operating-system API cannot close an already visible chooser may leave that chooser visible until the user dismisses it.
- **Local Host carriers only** — an OS dialog opens on the machine running the Host, so in-process and remote-browser deployments need the `-browse` composition instead. Platform failures surface through the owner's retryable folder dialog.
