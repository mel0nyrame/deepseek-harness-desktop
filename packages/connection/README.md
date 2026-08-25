# `@dsh-desktop/connection`

The desktop Service Provider for the published Client/Host connection
contracts. It carries unary requests, Client responses to Host requests,
ordered mux and Host streams, readiness, cancellation, and disconnect over a
validated IPC protocol. Each renderer subscription retains at most 256 parsed
frames. Queue overflow cancels that physical subscription and surfaces a
terminal error. One child-process connection owns at most one live mux stream
and one live Host stream; acknowledgements pace each source after delivery.

The preload adapter exposes only `dshDesktop`, uses fixed Electron IPC channel
names, validates calls and stream frames, and requires a sandboxed renderer
with Node integration disabled and context isolation enabled. The Host plugin
registers the existing `ctx.connection` service without a WebServer or network
listener.

Disposal cancels pending unary requests and both live subscriptions and
detaches the preload listener. Host disposal aborts request handlers and stream
sources, releases logical channel registrations, and waits for their cleanup.

Published `@deepseek-ai/dsh-client-connection@0.1.0-rc.8` remains the Service
Definition and Consumer implementation. The exact-version workspace patch
exposes only fetch-shaped transport factories and a Host channel registrar;
the desktop package owns the IPC protocol and adapters.
