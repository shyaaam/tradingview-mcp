import assert from 'node:assert/strict';
import test from 'node:test';

import { saveExistingChartScoped } from '../src/core/chart.js';
import { derivePaneIndicatorParityHash } from '../src/core/pane.js';
import { clearObserverSession, setObserverSession } from '../src/core/observer-session.js';

const targetUrl = 'https://www.tradingview.com/chart/chart-x/';
const signatures = {
  success: true,
  pane_count: 2,
  canonical_pane_index: 0,
  panes: [
    { index: 0, signature: 'a'.repeat(64), indicators: [] },
    { index: 1, signature: 'a'.repeat(64), indicators: [] },
  ],
};

test('scoped existing-chart save requires exact target and uses existing save only', async () => {
  const parityHash = derivePaneIndicatorParityHash({
    paneCapacity: 2,
    canonicalPaneIndex: 0,
    panes: signatures.panes,
  });
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp',
    chartTargetId: 'target-a',
    chartTargetUrl: targetUrl,
  });
  try {
    let evaluateCalls = 0;
    let saveExpression = '';
    const result = await saveExistingChartScoped({
      profile_id: 'profile-a',
      tab_index: 0,
      chart_target_id: 'target-a',
      chart_id: 'chart-x',
      layout_id: 'layout-x',
      expected_pane_count: 2,
      expected_indicator_parity_hash: parityHash,
      _deps: {
        listTabs: async () => ({
          success: true,
          tab_count: 1,
          tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }],
        }),
        getBoundClient: async () => ({ attached: true }),
        evaluate: async () => {
          evaluateCalls += 1;
          return evaluateCalls === 1
            ? { href: targetUrl, pane_count: 2, layout_id: 'layout-x', chart_available: true }
            : { href: targetUrl, layout_id: 'layout-x' };
        },
        evaluateAsync: async (expression) => {
          saveExpression = expression;
          return { success: true, uid: 'layout-x' };
        },
        inspectInventory: async () => ({
          success: true,
          pane_count: 2,
          panes: [
            { index: 0, indicators: [{ get_study_by_id_resolves: true }] },
            { index: 1, indicators: [{ get_study_by_id_resolves: true }] },
          ],
        }),
        inspectSignatures: async () => signatures,
      },
    });
    assert.equal(result.saved_existing, true);
    assert.equal(result.mutations_performed, true);
    assert.equal(result.saved_layout_id, 'layout-x');
    assert.match(saveExpression, /saveExistentChart/);
    assert.doesNotMatch(saveExpression, /saveNewChart|saveChartAs|renameChart|setLayout/);
  } finally {
    clearObserverSession();
  }
});

test('scoped existing-chart save rejects a different session target before save', async () => {
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp',
    chartTargetId: 'target-a',
    chartTargetUrl: targetUrl,
  });
  try {
    await assert.rejects(
      saveExistingChartScoped({
        profile_id: 'profile-a',
        tab_index: 0,
        chart_target_id: 'target-b',
        chart_id: 'chart-x',
        layout_id: 'layout-x',
        expected_pane_count: 2,
        expected_indicator_parity_hash: 'a'.repeat(64),
        _deps: { getBoundClient: async () => { throw new Error('must not attach'); } },
      }),
      /does not match observer session/,
    );
  } finally {
    clearObserverSession();
  }
});
