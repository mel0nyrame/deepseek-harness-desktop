# Agent Note: Desktop IPC connection provider over the published contracts

Status: implemented

English | [中文](2026-08-25-desktop-ipc-connection-provider.zh.md)

## Problem

The packaged desktop runtime must connect its context-isolated renderer to the DSH Host without opening a loopback server. Published `@deepseek-ai/dsh-client-connection@0.1.0-rc.8` owns the authoritative Client controller, readiness handshake, logical RPC contract, and Host service, but its physical adapters are fixed to browser fetch, WebSocket streams, and WebServer route registration. Copying the complete Client package into the desktop namespace would fork reconnect and protocol behavior.

## Decision

`@dsh-desktop/connection` is the desktop Service Provider for the published Client and Host connection contracts. Its Client adapter subclasses the published `AbstractApiClient` only to supply IPC-backed fetch and streams. The published Connection controller still owns readiness, reconnection, host-description publication, and generic RPC correlation. The Host adapter constructs the published `HostConnectionService` with an IPC channel registrar and routes `/api` through the published `toFetchHandler()` gateway.

The profile disables the official Connection row because its Host plugin requires WebServer. The desktop Client build prepends the exact published `@deepseek-ai/dsh-client-connection` browser factory, then registers the desktop factory whose external resolves to it through the published ModuleLoader contract. The `desktop-connection` row supplies `ctx.connection` on both sides without admitting the official WebServer-dependent Host plugin.

The preload exports one `dshDesktop` object with request, cancellation, subscription, acknowledgement, and stream-listener operations. Calls accept only the `dsh://app` authority and fixed IPC channels. The Host and preload parse untrusted message shapes before dispatch; stream payloads pass the published mux or Host schema. Renderer settings are `sandbox: true`, `nodeIntegration: false`, and `contextIsolation: true`.

Each Client subscription retains at most 256 parsed frames. The Host reads the next source frame only after the previous frame has crossed the process send callback and received a renderer acknowledgement; an early acknowledgement is retained as one credit. Abort, disconnect, and Cordis disposal release requests, subscriptions, listeners, and channel registrations.

## Published-package patch

The workspace patch applies only to `@deepseek-ai/dsh-client-connection@0.1.0-rc.8`:

- `createFetchConnectionRpc(fetcher)` accepts a fetch-shaped unary transport, while the existing Web implementation delegates to it.
- `createConnectionHandle(transport)` accepts the official API, RPC, and loopback aspects, while the existing Web plugin delegates to it.
- `ConnectionChannelRegistrar` lets `HostConnectionService` register fetch-shaped logical channels without WebServer; omitting it preserves the published Web behavior.

The upstream destination is `packages/client/connection/src/client/rpc.ts`, `packages/client/connection/src/client/index.ts`, and `packages/client/connection/src/rpc-host.ts` in `deepseek-ai/deepseek-harness`. The patch is deleted when an exact published release exposes equivalent Client transport factories and a Host channel registrar. `tests/connection-carrier.test.ts`, `tests/connection-host.test.ts`, and `tests/connection-composition.test.ts` pin the seam.

## Verification

The carrier contract covers unary success and business failure, Client responses to Host requests, independent mux and Host ordering, readiness, cancellation, malformed frames, disconnect, queue bounds, repeated subscription lifetime, and cleanup. The preload and Host suites cover boundary validation, fixed channels, early acknowledgements, generic RPC registration, synchronous stream-source failure, and disposal. The real composition test loads the assembled desktop Client artifact through a ModuleLoader registry, resolves its prepended published connection factory, activates the Client and Host package exports through app-boot Loader trees over an in-memory Electron relay, completes unary, logical RPC, and readiness calls, and observes no WebServer service or network listener.

The component has no standalone artifact build in the independent workspace. Issue #67 owns the Electron and published-runtime build integration; this component is gated by workspace typecheck, lint, focused tests, full tests, and the runtime patch manifest checks.

## Alternatives considered

**Copy the official Client connection package.** Rejected because readiness, reconnect, parser, and logical RPC behavior would acquire a second implementation and drift from Web consumers.

**Run the published Web carrier on loopback.** Rejected because the packaged application needs no network authority, port lifecycle, DNS-rebinding fence, or WebSocket server.

**Move the desktop IPC protocol into the official package.** Rejected because Electron process messages, preload exposure, and renderer security settings belong to the desktop provider, not the shared Service Definition.

**Replace acknowledgement backpressure with a larger queue.** Rejected because a finite queue changes the failure threshold but still lets a slow renderer outpace an unbounded Host stream. One-frame acknowledgement keeps accepted frames ordered and bounds work across both IPC hops.

## Consequences

Web deployments keep their published HTTP/WebSocket behavior, while the desktop Host provides the same service without WebServer or a listener. The renderer receives no Node.js or general Electron object. The desktop package adds only physical transport code and shared-boundary validation; official controller and API behavior remain single-sourced.

The exact-version patch is a release-maintenance obligation. Upgrading `@deepseek-ai/dsh-client-connection` requires revalidating or deleting the patch before the lockfile can move. Electron main still must relay the validated messages and own process supervision; issue #67 integrates that application lifecycle.
