import { jsonResult } from './_format.js';
import { chartRuntimeContentSnapshot } from '../core/chart-runtime-content-snapshot.js';
import { registerObserverTool } from '../release/observer-schema.js';

export function registerChartRuntimeContentSnapshotTools(server) {
  registerObserverTool(
    server,
    'chart_runtime_content_snapshot_v1',
    'Read exact target chart content after raw readiness checks without session recovery or mutation',
    async (input) => {
      try { return jsonResult(await chartRuntimeContentSnapshot(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
