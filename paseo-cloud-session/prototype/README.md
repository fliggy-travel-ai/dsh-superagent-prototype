# Cloud session probe (prototype)

Throwaway prototype for [fliggy-travel-ai/deepseek-harness#1707](https://github.com/fliggy-travel-ai/deepseek-harness/issues/1707): a Paseo provider plugin whose agents stand for a cloud Claude Code session. The plugin starts no local process. A remote caller drives each agent through plugin RPC over the daemon's pairing link.

This code answered the feasibility questions in the issue and is kept only as reference for the real package. It is not a supported plugin.

## Contents

- `plugin/`: the provider plugin (`cloud-session-probe`, Paseo `>=0.15.0 <0.16.0`). The daemon compiles `index.server.ts` itself and supplies `@getpaseo/plugin*` and `zod`, so the directory installs without `npm install`.
- `scripts/compile-test.mjs`, `scripts/sim-test.mjs`: compile the plugin and drive its provider connection in process with the daemon's own compiler and bundle evaluator, validating every event with `ProviderEventSchema`. They import Paseo 0.15.0 internals from a global `@getpaseo/cli` install.
- `scripts/rpc-probe.mjs`: calls a plugin RPC on the daemon named by the `PASEO_MINI_HOST` pairing link: `node rpc-probe.mjs <pluginId> <method> '<json>'`.

## RPC methods

- `probe.state`: sessions and recent emitted events.
- `probe.poll {max, peek, afterSeq}`: queued provider inputs.
- `probe.push {sessionId?, startTurn, reasoningText, toolCall, assistantText, usage, endTurn}`: timeline items and turn boundaries.
- `probe.emit {events}`: raw provider events.
- `probe.config {promptMode: turn|auto-complete}`.

The queue lives in memory and is lost when the plugin process restarts. The plugin stores no credentials and makes no network requests. Inputs are redacted before they are queued: environment values, URL query values, header values, and bearer tokens are replaced with `<redacted>`.
