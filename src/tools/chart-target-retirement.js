import { jsonResult } from './_format.js';
import {
  retireOwnedSavedLayoutTarget,
  retireSavedChartTarget,
} from '../core/chart-target-retirement.js';
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

  registerObserverTool(
    server,
    'tv_observer_retire_owned_saved_layout_target_v1',
    'Close only a V5-receipted exact target ID after rechecking account, profile, layout identity, and all other target state',
    async (input) => {
      try {
        const result = await retireOwnedSavedLayoutTarget(input, { resolveExactRunningProfile });
        return jsonResult({
          ...result,
          retirement_version: 'owned-saved-layout-retirement-v1',
          target_id: input.target_id,
          preserved_other_targets: true,
        });
      } catch (error) {
        return jsonResult({ success: false, error: error.message }, true);
      }
    },
  );
}
