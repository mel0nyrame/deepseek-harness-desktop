# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The Electron desktop overlay over the Web product composition. [`cordis.patch.yml`](cordis.patch.yml) rides over the [`dsh-web-app`](../web-app/README.md) bundle layer of the shipped `desktop` profile (`dsh-base` + `dsh-web-app` + this bundle): it disables every browser transport and runtime row (`web-startup`, `webserver`, `web-runtime`, `client-hmr`), clears the Connection row's `webServer` injection so the Host-side transport mounts nothing, disables the adaptive directory-picker row whose Web-server probe cannot settle here, mounts the renderless native-picker client half, and inserts the `desktop-runtime` row — this package's plugin ([`src/index.ts`](src/index.ts)). No HTTP listener opens on this path; the existing Web profile and Web development workflow are unchanged.

The plugin runs inside the dedicated DSH child process that the Electron shell ([`apps/desktop`](../../../apps/desktop)) supervises. It provides the `directoryPicker` and `nativePathOpener` services by correlating only `pick-directory` and `open-path` reverse requests with Electron main; cancellation and disposal remove each pending correlation, deliver cancellation, and ignore late settlements. The same child-process IPC endpoint carries the ordinary desktop carrier: after Loader settlement it announces the client-modules graph plus one resolved bundle path per entry ([`ready`](src/protocol.ts)), validates every parent message before dispatch, serves unary requests through the Connection service's shared `/api` fetch handler (the same wire parser and business dispatch the Web transport uses), and pumps the API proxy's ordered `mux` and `host` streams. Each stream awaits IPC send completion before reading its next frame, so backpressure bounds in-flight work without discarding an accepted message; cancellation aborts the source, and disposal awaits live requests and streams. The parent half — Electron main — validates child messages and canonical bundle paths, correlates requests, acknowledges renderer notifications through a bounded relay, and owns startup, readiness, renderer-generation cleanup, IPC disconnect, unexpected exit, and terminate-and-join shutdown ([`DshSupervisor`](../../../apps/desktop/src/supervisor.ts)). The renderer reaches DSH only through the sandboxed, context-isolated preload bridge whose client half ([`DesktopApiClient`](../../client/connection/src/client/desktop-api-client.ts)) implements the existing `IApiClient` surface, bounds each parsed-frame queue, and passes the shared Connection carrier contract unchanged.

## Model Experience

### Desktop child carrier

#### What the model sees

Nothing. The overlay changes which transport carries the existing API gateway and event streams; it adds no prompt sections, tools, shell variables, or model-visible events. A recorded `bash` tool turn still streams the same ordered `tool/result` event under the `TERMINAL_OK` marker as it does over HTTP.

#### Token effect

None. Zero tokens added or removed relative to the same composition served over HTTP.

#### KV Cache effect

None. The desktop profile's persona, tool surface, and event semantics are the Web product's; moving between Web and desktop does not change the system prompt.

## Known Limitations and Deferred Work

- **Unsigned macOS distribution** — packaging and installed-app smoke testing exist for the host architecture, but release signing, notarization, and the x64 artifact remain deferred.
- **Single-child supervision** — one DSH child per application instance; multi-window and multi-Host orchestration are out of scope for the first release.
- **No renderer CSP** — the desktop shell serves the client without a Content-Security-Policy header for parity with the Web deployment, whose client kernel evaluates `!!js` config through `new Function`; the narrow preload bridge and sandboxed renderer remain the security boundary.
- **Native actions require Electron main** — the child-provided picker and path opener fail unavailable after their IPC endpoint disconnects; the Web browse picker is not available because the desktop profile has no Web server.
