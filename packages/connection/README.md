# `@dsh-desktop/connection`

The desktop IPC connection provider role. This package implements the existing
Client/Host connection contracts over a validated, context-isolated preload
bridge: unary request/response, reverse Host responses, multiplexed streams,
readiness, cancellation, malformed-message refusal, disconnect, and bounded
subscription lifetime. The renderer receives no general Node.js or Electron
capability.

Official Service Definition and Consumer contracts remain authoritative; this
package is the desktop Service Provider. Implementation lands with
decoupling 4/10.
