import { jsonResult } from './_format.js';
import { hydrateChartTargetV2 } from '../core/chart-target-hydration-v2.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartTargetHydrationV2Tool(server) {
  registerObserverTool(
    server,
    'tv_observer_hydrate_chart_target_v2',
    'Hydrate one exact authorized chart target with renderer-verified navigation evidence',
    async (input) => {
      try { return jsonResult(await hydrateChartTargetV2(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
