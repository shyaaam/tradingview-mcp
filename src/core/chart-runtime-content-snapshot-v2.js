import { chartRuntimeContentSnapshot } from './chart-runtime-content-snapshot.js';
import {
  classifyReadinessOutcome,
  probeChartRuntimeReadiness,
} from './chart-runtime-readiness.js';

export const CHART_RUNTIME_CONTENT_SNAPSHOT_V2_CONTENT_WAIT_MS = 6_000;
export const CHART_RUNTIME_CONTENT_SNAPSHOT_V2_POLL_MS = 500;

/**
 * Deadline-safe recovery snapshot variant.
 *
 * v1 may spend 5s waiting for pre-readiness, 30s retrying content, and another
 * 5s waiting for post-readiness. v2 intentionally keeps the same exact content
 * and authority validation while replacing readiness waits with one immediate
 * read-only probe at each boundary and capping retryable content polling at 6s.
 * The transport lifecycle remains authoritative; this capability never raises it.
 */
export async function chartRuntimeContentSnapshotV2(input = {}, dependencies = {}) {
  const probe = dependencies.probe
    || ((probeInput) => probeChartRuntimeReadiness(probeInput, dependencies));
  const now = dependencies.now || Date.now;
  const immediateWaitReady = async (probeInput) => {
    const started = now();
    const snapshot = await probe(probeInput);
    const terminal = classifyReadinessOutcome(snapshot);
    const status = terminal || (snapshot?.ready === true ? 'READY' : 'TIMEOUT_NOT_READY');
    return {
      success: true,
      wait_version: 'chart-runtime-wait-ready-v1',
      status,
      attempts: 1,
      elapsed_ms: Math.max(0, Math.round(now() - started)),
      probe: snapshot,
      mutations_performed: false,
    };
  };

  const result = await chartRuntimeContentSnapshot(input, {
    ...dependencies,
    waitReady: immediateWaitReady,
    contentWaitTimeoutMs: CHART_RUNTIME_CONTENT_SNAPSHOT_V2_CONTENT_WAIT_MS,
    contentPollIntervalMs: CHART_RUNTIME_CONTENT_SNAPSHOT_V2_POLL_MS,
  });
  return {
    ...result,
    snapshot_version: 'chart-runtime-content-snapshot-v2',
  };
}
