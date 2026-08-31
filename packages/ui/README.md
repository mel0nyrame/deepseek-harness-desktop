# `@dsh-desktop/ui`

Host and Client contributions for the official DSH Desktop surface. The Client
entry contributes compact macOS window controls, native theme and Reduce
Transparency projection, zero-width sidebar collapse, and the durable sidebar
material setting through published extension points. Conversation, workspace,
directory picker, input triggers, and settings presentation remain the
published `@deepseek-ai/*` implementations.

The Host entry consumes `settings`, `clientModules`, and `connection`. It
registers the sidebar-material schema and a loopback-authority `/ui` logical
RPC that serves the published frontend allowlist and graph-advertised Client
bundles as bounded base64 responses. Missing, malformed, escaping, unknown, or
unreadable asset paths return an asset-level 404; malformed RPC calls return
`bad-request`. Registrations follow their Cordis owner fibers.

No official Client package is copied into the desktop namespace and no socket
is opened. Electron validates the RPC envelope and body bound again. The
published frontend still requires inline boot code and `unsafe-eval`; the
document is therefore protected by a self-only CSP plus Electron sandboxing,
context isolation, disabled Node integration, and the narrow preload bridge.
