import { jsonResult } from './_format.js';
import { retireSavedChartTarget } from '../core/chart-target-retirement.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartTargetRetirementTool(server) {
  registerObserverTool(
    server,
    'tv_observer_retire_saved_chart_v2',
    'Close one exact saved-layout tab by server layout ID while preserving the saved layout and every other target',
    async (input) => {
      try { return jsonResult(await retireSavedChartTarget(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
