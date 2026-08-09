#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerReleaseTools } from './tools/release.js';
import { registerHealthTools } from './tools/health.js';
import { registerObserverEvidenceTools } from './tools/observer-evidence.js';
import { registerObserverScreenshotTool } from './tools/observer-screenshot.js';
import { registerChartTools } from './tools/chart.js';
import { registerPineTools } from './tools/pine.js';
import { registerDataTools } from './tools/data.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDrawingTools } from './tools/drawing.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerBatchTools } from './tools/batch.js';
import { registerReplayTools } from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools } from './tools/ui.js';
import { registerPaneTools } from './tools/pane.js';
import { registerTabTools } from './tools/tab.js';
import { registerChartTargetHydrationTool } from './tools/chart-target-hydration.js';
import { registerChartRuntimeReadinessTools } from './tools/chart-runtime-readiness.js';
import { registerChartRuntimeContentSnapshotTools } from './tools/chart-runtime-content-snapshot.js';
import { buildObserverContract, SERVER_NAME, SERVER_VERSION } from './release/identity.js';
import { installStdioLifecycle } from './release/lifecycle.js';
import { disconnectStrict } from './connection.js';

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
  },
  {
    instructions: `TradingView MCP — versioned tools for reading and controlling a live TradingView chart through CloakBrowser Manager.

For TV Observer integration, call tv_observer_contract first and verify the exact release commit, manifest hash, lifecycle policy, capability names, schemas, and mutation classifications before any browser work.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)
- indicator_apply_scoped / indicator_update_settings_scoped → apply/update studies on an explicit profile/tab/pane and return scoped evidence

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs`,
  }
);

registerReleaseTools(server);
registerHealthTools(server);
registerObserverEvidenceTools(server);
registerObserverScreenshotTool(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerChartTargetHydrationTool(server);
registerChartRuntimeReadinessTools(server);
registerChartRuntimeContentSnapshotTools(server);

const contract = buildObserverContract();
const startupEvent = {
  event: 'tradingview-mcp.start',
  server: contract.serverName,
  version: contract.serverVersion,
  expectedCommit: contract.expectedCommit,
  observedCommit: contract.observedCommit,
  releaseCommit: contract.releaseCommit,
  releaseCommitMatch: contract.releaseCommitMatch,
  releaseDirty: contract.releaseDirty,
  releaseReady: contract.releaseReady,
  observerContract: contract.contractId,
  manifestHash: contract.manifestHash,
  disclaimer: 'Unofficial tool; ensure usage complies with TradingView Terms of Use.',
};
process.stderr.write(`${JSON.stringify(startupEvent)}\n`);

const transport = new StdioServerTransport();
installStdioLifecycle({
  close: async () => {
    const failures = [];
    try {
      if (typeof server.close === 'function') await server.close();
      else if (typeof transport.close === 'function') await transport.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await disconnectStrict();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'MCP observer shutdown failed');
    }
  },
  forceClose: () => transport.close?.(),
  hardExit: (code) => process.exit(code),
});
await server.connect(transport);
