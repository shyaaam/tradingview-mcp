import assert from 'node:assert/strict';
import test from 'node:test';

import { invalidateObserverSession, bindObserverSession } from '../src/connection.js';
import { readSavedLayoutIdentityV1 } from '../src/core/chart-saved-layout-identity.js';

const profileId = 'profile-a';
const targetId = 'target-a';
const chartId = 'chart-a';
const canonicalUrl = `https://www.tradingview.com/chart/${chartId}/`;

function input(overrides = {}) {
  return {
    profile_id: profileId,
    tab_index: 0,
    chart_target_id: targetId,
    expected_chart_id: chartId,
    expected_workspace_layout_id: '8',
    expected_pane_count: 8,
    ...overrides,
  };
}

function makeDeps(evidence = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      async listTabs() {
        calls.push('tab_list');
        return { success: true, tab_count: 1, tabs: [{ index: 0, id: targetId, chart_id: chartId, url: canonicalUrl }] };
      },
      async getBoundClient() { calls.push('get_bound_client'); return {}; },
      async evaluate(expression) {
        calls.push('evaluate');
        assert.match(expression, /metaInfo/);
        return {
          href: canonicalUrl,
          canonical_url: canonicalUrl,
          chart_id: chartId,
          workspace_layout_id: '8',
          saved_layout_uid: 'layout-uid-distinct-from-chart',
          pane_count: 8,
          chart_available: true,
          ...evidence,
        };
      },
    },
  };
}

test('read-only saved-layout identity returns metaInfo uid separately from chart ID', async () => {
  await bindObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    profileId,
    cdpUrl: 'http://127.0.0.1:9222',
    chartTargetId: targetId,
    chartTargetUrl: canonicalUrl,
  });
  try {
    const { deps, calls } = makeDeps();
    const result = await readSavedLayoutIdentityV1({ ...input(), _deps: deps });
    assert.equal(result.saved_layout_uid, 'layout-uid-distinct-from-chart');
    assert.notEqual(result.saved_layout_uid, result.chart_id);
    assert.deepEqual(calls, ['tab_list', 'get_bound_client', 'evaluate']);
  } finally {
    await invalidateObserverSession();
  }
});

test('read-only saved-layout identity fails before evaluation on exact-target drift', async () => {
  await bindObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    profileId,
    cdpUrl: 'http://127.0.0.1:9222',
    chartTargetId: targetId,
    chartTargetUrl: canonicalUrl,
  });
  try {
    const { deps, calls } = makeDeps();
    await assert.rejects(
      readSavedLayoutIdentityV1({ ...input(), expected_chart_id: 'other-chart', _deps: deps }),
      /target or profile does not match/,
    );
    assert.deepEqual(calls, ['tab_list']);
  } finally {
    await invalidateObserverSession();
  }
});

test('read-only saved-layout identity rejects missing UID evidence', async () => {
  await bindObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    profileId,
    cdpUrl: 'http://127.0.0.1:9222',
    chartTargetId: targetId,
    chartTargetUrl: canonicalUrl,
  });
  try {
    const { deps } = makeDeps({ saved_layout_uid: null });
    await assert.rejects(
      readSavedLayoutIdentityV1({ ...input(), _deps: deps }),
      /does not match exact chart authority/,
    );
  } finally {
    await invalidateObserverSession();
  }
});
