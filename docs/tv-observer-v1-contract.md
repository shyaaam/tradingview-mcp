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
- expected commit, observed commit, match status, and dirty-check status;
- `tv-observer-v1` contract/schema versions;
- canonical SHA-256 manifest hash;
- complete capability manifest and lifecycle limits.

`TRADINGVIEW_MCP_RELEASE_COMMIT` is an expected identity only. A Git checkout observes `git rev-parse HEAD` and fails readiness when tracked files are dirty or expected/observed commits differ. Packaged installs observe build-generated `src/release/release-metadata.json`; missing or mismatched metadata fails readiness. Runtime environment input never proves packaged code identity.

## Capability classes

- `read_only`: no browser or process mutation.
- `bootstrap_mutation`: bounded process/profile/tab preparation.
- `browser_focus_mutation`: changes selected tab/focus only.
- `chart_mutation`: changes symbol or timeframe and requires exact readback.

The manifest lists exact capability names and JSON input/result schemas generated from the same Zod definitions registered with MCP. The release tests compare every admitted capability against live `tools/list` output. TV Observer must compare the expected manifest hash before admitting runtime preparation or observation work.

## Lifecycle limits

The manifest currently declares:

- startup/handshake: 5 seconds;
- default call: 15 seconds;
- graceful shutdown: 2 seconds;
- captured stderr: 65,536 bytes.

Shutdown timeout closes the transport and invokes hard exit with code `1`; a hanging cleanup cannot keep the MCP child alive.

The general-purpose `tv_launch` tool is not observer-admitted. Observer preparation uses `tv_observer_prepare`, which requires exact `profile_id`, Manager mode, and explicit `restart` opt-in. It never auto-selects profiles, falls back to local TradingView, or runs broad process termination.

These are observer-enforced maximums, not generic retry instructions. Post-mutation timeout remains ambiguous and must not be retried automatically.

## Runtime pin

The supported runtime is Node `22.22.3`, recorded in `docs/runtime/node-version.txt` and `package.json#engines`. Direct dependencies are exact in `package.json` and `package-lock.json`.
