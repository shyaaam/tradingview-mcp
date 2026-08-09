import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';

import {
  CHART_RUNTIME_READINESS_EXPRESSION,
  classifyReadinessOutcome,
  probeChartRuntimeReadiness,
  waitForChartRuntimeReady,
  withExactRawTarget,
} from '../src/core/chart-runtime-readiness.js';
import { observerToolDefinitions } from '../src/release/observer-schema.js';

const PROFILE_ID = 'profile-disposable';
const TARGET_ID = 'target-exact';
const TARGET_URL = 'https://www.tradingview.com/chart/SJ0J0zgb/';
const MANAGER_URL = 'http://127.0.0.1:8080/api';

function response(value) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => value };
}

function fakeFetch({ targetUrl = TARGET_URL, targetId = TARGET_ID } = {}) {
  return async (url) => {
    if (url.endsWith('/profiles')) {
      return response([{ id: PROFILE_ID, status: 'running', cdp_url: `${MANAGER_URL}/profiles/${PROFILE_ID}/cdp` }]);
    }
    if (url.endsWith('/json/list')) {
      return response([{ type: 'page', id: targetId, url: targetUrl, webSocketDebuggerUrl: 'ws://target-exact' }]);
    }
    throw new Error(`unexpected URL: ${url}`);
  };
}

function fakeConnect(snapshot, calls = {}) {
  return async () => ({
    Runtime: {
      enable: async () => { calls.runtimeEnable = (calls.runtimeEnable || 0) + 1; },
      evaluate: async ({ expression }) => {
        calls.expression = expression;
        return { result: { value: snapshot } };
      },
    },
    close: async () => { calls.closed = (calls.closed || 0) + 1; },
  });
}

function readySnapshot(overrides = {}) {
  return {
    document_ready_state: 'complete',
    current_url: TARGET_URL,
    current_path: '/chart/SJ0J0zgb/',
    tradingview_api_present: true,
    tradingview_api_type: 'object',
    chart_widget_collection_present: true,
    chart_widget_collection_type: 'object',
    active_widget_wrapper_present: true,
    active_widget_wrapper_type: 'object',
    active_widget_value_callable: true,
    active_widget_non_null: true,
    workspace_layout_status: 'ready',
    workspace_layout_id: '8',
    saved_layout_meta_info_status: 'ready',
    saved_layout_meta_info_type: 'object',
    saved_layout_uid: 'SJ0J0zgb',
    saved_layout_uid_ready: true,
    account_subject_candidate_count: 1,
    account_subject_state: 'ready',
    disconnected_session_state: 'absent',
    disconnected_popup_count: 0,
    exact_connect_count: 0,
    login_state: 'absent',
    login_marker_count: 0,
    mutations_performed: false,
    ...overrides,
  };
}

function probeDeps(snapshot, calls = {}, fetchOptions = {}) {
  return {
    managerBaseUrl: MANAGER_URL,
    fetch: fakeFetch(fetchOptions),
    connect: fakeConnect(snapshot, calls),
  };
}

function input(overrides = {}) {
  return { profile_id: PROFILE_ID, target_id: TARGET_ID, target_url: TARGET_URL, ...overrides };
}

test('exact target can exist while runtime remains not ready, without throwing', async () => {
  const result = await probeChartRuntimeReadiness(input(), probeDeps(readySnapshot({ chart_widget_collection_present: false })));
  assert.equal(result.success, true);
  assert.equal(result.target_state, 'exact');
  assert.equal(result.chart_widget_collection_present, false);
  assert.equal(result.ready, false);
  assert.equal(result.mutations_performed, false);
});

test('missing collection and null active widget are ordinary not-ready states', async () => {
  const missingCollection = await probeChartRuntimeReadiness(input(), probeDeps(readySnapshot({ chart_widget_collection_present: false })));
  const nullActive = await probeChartRuntimeReadiness(input(), probeDeps(readySnapshot({ active_widget_non_null: false })));
  assert.equal(missingCollection.ready, false);
  assert.equal(nullActive.ready, false);
  assert.equal(nullActive.active_widget_non_null, false);
});

test('layout disagreement produces IDENTITY_AMBIGUOUS', async () => {
  const probe = readySnapshot({ workspace_layout_status: 'ambiguous', workspace_layout_id: null, ready: false });
  const result = await waitForChartRuntimeReady(input(), {
    probe: async () => ({
      success: true,
      probe_version: 'chart-runtime-readiness-probe-v1',
      ...probe,
      profile_id: PROFILE_ID,
      target_id: TARGET_ID,
      target_url: TARGET_URL,
      profile_state: 'ready',
      target_state: 'exact',
      probe_error: null,
      ready: false,
    }),
    now: (() => { let value = 0; return () => value; })(),
    sleep: async () => {},
  });
  assert.equal(result.status, 'IDENTITY_AMBIGUOUS');
  assert.equal(classifyReadinessOutcome(result.probe), 'IDENTITY_AMBIGUOUS');
});

test('disconnected popup is detected read-only and never clicked', async () => {
  const calls = {};
  const result = await waitForChartRuntimeReady(input(), {
    ...probeDeps(readySnapshot({ disconnected_session_state: 'present', disconnected_popup_count: 1, exact_connect_count: 1 }), calls),
  });
  assert.equal(result.status, 'DISCONNECTED_SESSION_PRESENT');
  assert.equal(result.probe.mutations_performed, false);
  assert.equal(calls.runtimeEnable, 1);
  assert.equal(calls.closed, 1);
  assert.doesNotMatch(calls.expression, /\.click\s*\(/u);
});

test('login state is distinct from disconnected session state', async () => {
  const result = await waitForChartRuntimeReady(input(), {
    ...probeDeps(readySnapshot({ login_state: 'present', login_marker_count: 1 })),
  });
  assert.equal(result.status, 'LOGIN_REQUIRED');
  assert.equal(result.probe.login_state, 'present');
  assert.equal(result.probe.disconnected_session_state, 'absent');
});

test('target URL drift blocks without falling back to another target', async () => {
  const calls = {};
  const result = await waitForChartRuntimeReady(input(), {
    ...probeDeps(readySnapshot(), calls, { targetUrl: 'https://www.tradingview.com/chart/other/' }),
  });
  assert.equal(result.status, 'TARGET_CHANGED');
  assert.equal(calls.runtimeEnable || 0, 0);
});

test('runtime URL drift after exact attachment blocks before READY', async () => {
  const result = await waitForChartRuntimeReady(input(), {
    ...probeDeps(readySnapshot({ current_url: 'https://www.tradingview.com/chart/other/' })),
  });
  assert.equal(result.status, 'TARGET_CHANGED');
  assert.equal(result.probe.target_state, 'changed');
});

test('missing exact target does not select another target with matching URL', async () => {
  const result = await probeChartRuntimeReadiness(input(), probeDeps(readySnapshot(), {}, { targetId: 'other-target' }));
  assert.equal(result.target_state, 'missing');
  assert.equal(result.ready, false);
});

test('raw content binding uses one exact target and closes without session recovery', async () => {
  const calls = {};
  const result = await withExactRawTarget(input(), async ({ target, evaluate }) => ({
    target_id: target.id,
    snapshot: await evaluate(CHART_RUNTIME_READINESS_EXPRESSION),
  }), probeDeps(readySnapshot(), calls));
  assert.equal(result.target_id, TARGET_ID);
  assert.equal(result.snapshot.mutations_performed, false);
  assert.equal(calls.runtimeEnable, 1);
  assert.equal(calls.closed, 1);
});

test('raw content binding rejects exact URL drift before opening CDP', async () => {
  const calls = {};
  await assert.rejects(
    () => withExactRawTarget(input(), async () => { throw new Error('must not run'); }, probeDeps(readySnapshot(), calls, { targetUrl: 'https://www.tradingview.com/chart/other/' })),
    /Exact target or URL changed/,
  );
  assert.equal(calls.runtimeEnable || 0, 0);
});

test('polling is bounded and READY waits for every authority surface', async () => {
  let probeCalls = 0;
  let clock = 0;
  const result = await waitForChartRuntimeReady({ ...input(), timeout_ms: 3, poll_interval_ms: 1 }, {
    probe: async () => {
      probeCalls += 1;
      return {
        success: true,
        probe_version: 'chart-runtime-readiness-probe-v1',
        profile_id: PROFILE_ID,
        target_id: TARGET_ID,
        target_url: TARGET_URL,
        profile_state: 'ready',
        target_state: 'exact',
        ...readySnapshot(probeCalls < 2 ? { chart_widget_collection_present: false } : {}),
        probe_error: null,
        ready: probeCalls >= 2,
      };
    },
    now: () => clock,
    sleep: async () => { clock += 1; },
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.attempts, 2);
  assert.equal(probeCalls, 2);

  clock = 0;
  probeCalls = 0;
  const timeout = await waitForChartRuntimeReady({ ...input(), timeout_ms: 3, poll_interval_ms: 1 }, {
    probe: async () => {
      probeCalls += 1;
      return {
        success: true,
        probe_version: 'chart-runtime-readiness-probe-v1',
        profile_id: PROFILE_ID,
        target_id: TARGET_ID,
        target_url: TARGET_URL,
        profile_state: 'ready',
        target_state: 'exact',
        ...readySnapshot({ chart_widget_collection_present: false }),
        probe_error: null,
        ready: false,
      };
    },
    now: () => clock,
    sleep: async () => { clock += 1; },
  });
  assert.equal(timeout.status, 'TIMEOUT_NOT_READY');
  assert.ok(timeout.attempts <= 5);
  assert.equal(timeout.probe.mutations_performed, false);
});

test('readiness source contains no recovery or mutating browser operation', async () => {
  const source = await readFile(new URL('../src/core/chart-runtime-readiness.js', import.meta.url), 'utf8');
  for (const forbidden of [/recoverDisconnectedSession/iu, /\.click\s*\(/u, /Page\.navigate/iu, /Target\.createTarget/iu, /\.reload\s*\(/u, /saveExisting/iu, /chart_set_symbol/iu, /chart_set_timeframe/iu, /pane_indicator/iu]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.match(CHART_RUNTIME_READINESS_EXPRESSION, /mutations_performed: false/u);
});

test('public readiness contracts are read-only and validate result shape', () => {
  assert.equal(observerToolDefinitions.chart_runtime_readiness_probe_v1.classification, 'read_only');
  assert.equal(observerToolDefinitions.chart_runtime_wait_ready_v1.classification, 'read_only');
  const probe = {
    success: true,
    probe_version: 'chart-runtime-readiness-probe-v1',
    profile_id: PROFILE_ID,
    target_id: TARGET_ID,
    target_url: TARGET_URL,
    profile_state: 'ready',
    target_state: 'exact',
    ...readySnapshot(),
    probe_error: null,
    ready: true,
  };
  assert.doesNotThrow(() => z.object(observerToolDefinitions.chart_runtime_readiness_probe_v1.outputSchema).parse(probe));
  assert.doesNotThrow(() => z.object(observerToolDefinitions.chart_runtime_wait_ready_v1.outputSchema).parse({
    success: true,
    wait_version: 'chart-runtime-wait-ready-v1',
    status: 'READY',
    attempts: 1,
    elapsed_ms: 0,
    probe,
    mutations_performed: false,
  }));
});
