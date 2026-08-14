# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The Electron desktop overlay over the Web product composition. [`cordis.patch.yml`](cordis.patch.yml) rides over the [`dsh-web-app`](../web-app/README.md) bundle layer of the shipped `desktop` profile (`dsh-base` + `dsh-web-app` + this bundle): it disables every browser transport and runtime row (`web-startup`, `webserver`, `web-runtime`, `client-hmr`), clears the Connection row's `webServer` injection so the Host-side transport mounts nothing, pins the native directory picker (the auto picker's Web-server probe can never settle without a server), and inserts the `desktop-runtime` row — this package's plugin ([`src/index.ts`](src/index.ts)). No HTTP listener opens on this path; the existing Web profile and Web development workflow are unchanged.

The plugin runs inside the dedicated DSH child process that the Electron shell ([`apps/desktop`](../../../apps/desktop)) supervises. It owns one child-process IPC carrier end: it awaits Loader settlement and announces the client-modules graph plus one resolved bundle path per entry ([`ready`](src/protocol.ts)), serves validated unary requests through the Connection service's shared `/api` fetch handler (the same dispatch the Web transport uses), pumps the API proxy's `mux` and `host` event streams as ordered logical streams with cancellation and deterministic `stream-end` closure, and aborts every live request and stream on disposal. The parent half — Electron main — supervises startup, readiness, unexpected exit, and terminate-and-join shutdown ([`DshSupervisor`](../../../apps/desktop/src/supervisor.ts)), and the renderer reaches DSH only through the sandboxed, context-isolated preload bridge whose client half ([`DesktopApiClient`](../../client/connection/src/client/desktop-api-client.ts)) implements the existing `IApiClient` surface and passes the shared Connection carrier contract unchanged.

## Model Experience

### Desktop child carrier

#### What the model sees

Nothing. The overlay changes which transport carries the existing API gateway and event streams; it adds no prompt sections, tools, shell variables, or model-visible events. A recorded `bash` tool turn still streams the same ordered `tool/result` event under the `TERMINAL_OK` marker as it does over HTTP.

#### Token effect

None. Zero tokens added or removed relative to the same composition served over HTTP.

#### KV Cache effect

None. The desktop profile's persona, tool surface, and event semantics are the Web product's; moving between Web and desktop does not change the system prompt.

## Known Limitations and Deferred Work

- **Development-only today** — the tracer bullet runs from the source tree (`pnpm run dev:desktop`); packaging, signing, and installed-app smoke testing are issue #3, and the native macOS window experience is issue #4.
- **Single-child supervision** — one DSH child per application instance; multi-window and multi-Host orchestration are out of scope for the first release.
- **IPC backpressure is unbounded** — stream pumps forward as fast as Electron main consumes; bounded queues and renderer-lifecycle closure are issue #5.
- **No renderer CSP** — the desktop shell serves the client without a Content-Security-Policy header for parity with the Web deployment, whose client kernel evaluates `!!js` config through `new Function`; the preload bridge and sandboxed renderer are the boundary, and CSP hardening belongs to issue #5.
- **The picker is pinned to native** — the desktop surface mounts `dsh-host-directory-picker-native` (an OS chooser on the host display); the Web browse backend is not available without a Web server.
