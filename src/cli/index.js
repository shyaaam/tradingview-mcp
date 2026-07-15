#!/usr/bin/env node

/**
 * tv — CLI for TradingView Desktop via Chrome DevTools Protocol.
 * Outputs JSON to stdout. Errors to stderr.
 * Exit codes: 0 success, 1 error, 2 connection failure.
 *
 * MCP tools are also accessible through CLI command groups.
 * Pipe-friendly: every command outputs JSON for use with jq.
 */

import './commands/release.js';
import './commands/health.js';
import './commands/chart.js';
import './commands/data.js';
import './commands/pine.js';
import './commands/capture.js';
import './commands/replay.js';
import './commands/drawing.js';
import './commands/alerts.js';
import './commands/watchlist.js';
import './commands/layout.js';
import './commands/indicator.js';
import './commands/ui.js';
import './commands/pane.js';
import './commands/tab.js';
import './commands/stream.js';

import { run } from './router.js';
await run(process.argv);
