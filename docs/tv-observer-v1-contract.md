# `tv-observer-v1` release contract

This document defines the machine boundary consumed by TV Observer v2 Stage -1B.

## Transport

- MCP over child-process stdio only.
- Launch without a shell.
- No TCP listener is exposed by the MCP server.
- The observer owns startup and per-call deadlines, captured stderr limits, cancellation, process-group termination, and orphan checks.
- Closing stdin, `SIGINT`, `SIGTERM`, or `SIGHUP` initiates one bounded server shutdown.

## Release identity

The MCP tool `tv_observer_contract` and CLI commands `tv version` / `tv contract` return:

- server name and package-backed version;
- running Node version;
- exact release commit and its source;
- `tv-observer-v1` contract/schema versions;
- canonical SHA-256 manifest hash;
- complete capability manifest and lifecycle limits.

The commit is read from `TRADINGVIEW_MCP_RELEASE_COMMIT` when supplied. Otherwise a local Git checkout reports `git rev-parse HEAD`. A packaged checkout without either source returns `releaseReady=false`; TV Observer must block startup.

## Capability classes

- `read_only`: no browser or process mutation.
- `bootstrap_mutation`: bounded process/profile/tab preparation.
- `browser_focus_mutation`: changes selected tab/focus only.
- `chart_mutation`: changes symbol or timeframe and requires exact readback.

The manifest lists exact capability names and JSON input/result schemas. TV Observer must compare the expected manifest hash before admitting runtime preparation or observation work.

## Lifecycle limits

The manifest currently declares:

- startup/handshake: 5 seconds;
- default call: 15 seconds;
- graceful shutdown: 2 seconds;
- captured stderr: 65,536 bytes.

These are observer-enforced maximums, not generic retry instructions. Post-mutation timeout remains ambiguous and must not be retried automatically.

## Runtime pin

The supported runtime is Node `22.22.3`, recorded in `docs/runtime/node-version.txt` and `package.json#engines`. Direct dependencies are exact in `package.json` and `package-lock.json`.
