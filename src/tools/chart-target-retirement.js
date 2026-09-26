import { jsonResult } from './_format.js';
import { retireSavedChartTarget } from '../core/chart-target-retirement.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartTargetRetirementTool(server) {
  registerObserverTool(
    server,
    'tv_observer_retire_saved_chart_v1',
    'Close one exact reviewed saved-chart tab while preserving its saved chart and every other chart target',
    async (input) => {
      try { return jsonResult(await retireSavedChartTarget(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
