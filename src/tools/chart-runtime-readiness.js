import { jsonResult } from './_format.js';
import {
  probeChartRuntimeReadiness,
  waitForChartRuntimeReady,
} from '../core/chart-runtime-readiness.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartRuntimeReadinessTools(server) {
  registerObserverTool(
    server,
    'chart_runtime_readiness_probe_v1',
    'Read exact target chart-runtime readiness without recovery, navigation, focus, or mutation',
    async (input) => {
      try { return jsonResult(await probeChartRuntimeReadiness(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );

  registerObserverTool(
    server,
    'chart_runtime_wait_ready_v1',
    'Poll exact target chart-runtime readiness using only the read-only readiness probe',
    async (input) => {
      try { return jsonResult(await waitForChartRuntimeReady(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
