import { jsonResult } from './_format.js';
import { openBootstrapChartTarget } from '../core/chart-target-open.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartTargetOpenTool(server) {
  registerObserverTool(
    server,
    'tv_observer_open_bootstrap_chart_target_v1',
    'Resolve an exact running CloakBrowser profile name and open one generic TradingView chart for fresh-account bootstrap',
    async (input) => {
      try { return jsonResult(await openBootstrapChartTarget(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
