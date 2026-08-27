# `@dsh-desktop/native`

Native capability providers for DSH Desktop, implemented against the official
Service Definition contracts. The DSH child does not spawn the desktop
directory chooser or `host.openPath` handoff; Electron main is the
operating-system adapter. Other native editor handoffs remain official child
behavior.

- The default export implements the published `ctx.directoryPicker` seam
  (`@deepseek-ai/dsh-host-directory-picker`) with the stable `native`
  capability: each `pick(signal)` is one reverse request over the validated
  desktop IPC protocol to the shell.
- `./gateway` mounts `ctx.apiProxy` through the published `createApiProxy`
  factory with only the shell-owned `openPath` closure injected; its exported
  `inject` mirrors `ApiProxyService.inject` so loader ordering follows the
  official gateway.
- Both rows share one host-side correlation channel per IPC endpoint. Every
  settlement removes its correlation first — late, duplicated, or malformed
  replies cannot revive a settled request — and Cordis disposal, disconnect,
  and cancellation reject live callers deterministically.

Requests are `capability-request` messages (child → main) with validated
absolute paths; settlements are `capability-response`/`capability-error`
messages (main → child). The renderer receives none of this: no preload
surface changes, no new bridge methods.

This package imports no Electron API and is mounted only by the desktop bundle
patch (`packages/bundle/cordis.patch.yml`), so web deployments keep composing
the official auto/native/browse picker backends unchanged.
