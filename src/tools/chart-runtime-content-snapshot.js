import { jsonResult } from './_format.js';
import { chartRuntimeContentSnapshot } from '../core/chart-runtime-content-snapshot.js';
import { chartRuntimeContentSnapshotV2 } from '../core/chart-runtime-content-snapshot-v2.js';
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
  registerObserverTool(
    server,
    'chart_runtime_content_snapshot_v2',
    'Read exact target chart content with immediate readiness probes and bounded retry budget below transport timeout',
    async (input) => {
      try { return jsonResult(await chartRuntimeContentSnapshotV2(input)); }
      catch (error) { return jsonResult({ success: false, error: error.message }, true); }
    },
  );
}
