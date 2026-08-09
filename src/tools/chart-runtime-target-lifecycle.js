import { jsonResult } from './_format.js';
import { chartRuntimeTargetLifecycleTrace } from '../core/chart-runtime-target-lifecycle.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartRuntimeTargetLifecycleTools(server) {
  registerObserverTool(
    server,
    'chart_runtime_target_lifecycle_trace_v1',
    'Read exact target lifecycle across Manager, browser targets, and page runtime without adoption or mutation',
    async (input) => {
      try { return jsonResult(await chartRuntimeTargetLifecycleTrace(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
