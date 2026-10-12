import { jsonResult } from './_format.js';
import { retireOwnedSavedLayoutTarget } from '../core/chart-target-retirement.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartTargetRetirementTool(server, dependencies = {}) {
  registerObserverTool(
    server,
    'tv_observer_retire_owned_saved_layout_target_v1',
    'Close only the target named by a verified fresh-layout creation receipt.',
    async (input) => {
      try { return jsonResult(await retireOwnedSavedLayoutTarget(input, dependencies)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
