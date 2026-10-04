import { jsonResult } from './_format.js';
import { retireSavedChartTarget } from '../core/chart-target-retirement.js';
import { retireOwnedDiagnosticTarget } from '../core/diagnostic-target-retirement.js';
import { resolveExactRunningProfile } from '../core/chart-target-open.js';
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
    'tv_observer_retire_owned_diagnostic_target_v1',
    'Close only the exact unsaved diagnostic page proven by a fresh-target bootstrap result, then verify its absence and preserve all other page targets',
    async (input) => {
      try {
        return jsonResult(await retireOwnedDiagnosticTarget(input, { resolveExactRunningProfile }));
      } catch (error) {
        return jsonResult({ success: false, error: error.message }, true);
      }
    },
  );
}
