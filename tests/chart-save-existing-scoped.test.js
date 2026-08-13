import assert from 'node:assert/strict';
import test from 'node:test';

import { invalidateObserverSession, bindObserverSession } from '../src/connection.js';
import {
  deriveExistingChartParitySha256,
  saveExistingChartScopedV2,
  ScopedExistingChartSaveError,
} from '../src/core/chart-save.js';

const profileId = 'profile-a';
const targetId = 'target-a';
const chartId = 'chart-a';
const canonicalUrl = `https://www.tradingview.com/chart/${chartId}/`;
const signature = 'a'.repeat(64);

function evidence() {
  const indicators = [{
    indicator_id: 'RSI@tv-basicstudies',
    entity_id: 'study-a',
    indicator_name: 'Relative Strength Index',
    is_price_study: false,
    settings: { length: 14 },
  }];
  return {
    signatures: {
      success: true,
      schema_version: 'pane-indicator-signatures-v1',
      pane_count: 1,
      canonical_pane_index: 0,
      panes: [{ index: 0, signature, indicators }],
    },
  };
}

function input(overrides = {}) {
  const parity = deriveExistingChartParitySha256(evidence().signatures);
  return {
    profile_id: profileId,
    tab_index: 0,
    chart_target_id: targetId,
    expected_chart_id: chartId,
    expected_workspace_layout_id: '8',
    expected_saved_layout_uid: chartId,
    expected_pane_count: 1,
    expected_eight_pane_parity_sha256: parity,
    ...overrides,
  };
}

function layoutEvidence() {
  return {
    href: canonicalUrl,
    canonical_url: canonicalUrl,
    chart_id: chartId,
    workspace_layout_id: '8',
    saved_layout_uid: chartId,
    pane_count: 1,
    chart_available: true,
    save_service_available: true,
    save_existent_chart_type: 'function',
  };
}

function makeDeps({ save = async () => ({ success: true, uid: chartId }), signatures = evidence().signatures } = {}) {
  const calls = [];
  const expressions = [];
  return {
    calls, expressions,
    deps: {
      async listTabs() {
        calls.push('tab_list');
        return { success: true, tab_count: 1, tabs: [{ index: 0, id: targetId, chart_id: chartId, url: canonicalUrl }] };
      },
      async getBoundClient() { calls.push('get_bound_client'); return {}; },
      async evaluate(expression) { calls.push('evaluate'); expressions.push(expression); assert.match(expression, /_saveChartService|_layoutType|metaInfo/); return layoutEvidence(); },
      async evaluateAsync(expression) { calls.push('save'); expressions.push(expression); assert.match(expression, /saveExistentChart/); return save(expression); },
      async inspectSignatures() { calls.push('pane_indicator_signatures'); return signatures; },
    },
  };
}

test('scoped save confirms exact existing-chart callback and readback', async () => {
  await bindObserverSession({ managerBaseUrl: 'http://127.0.0.1:8080/api', profileId, cdpUrl: 'http://127.0.0.1:9222', chartTargetId: targetId, chartTargetUrl: canonicalUrl });
  try {
    const { deps, calls, expressions } = makeDeps();
    const result = await saveExistingChartScopedV2({ ...input(), _deps: deps });
    assert.equal(result.save_version, 'chart-save-existing-scoped-v2');
    assert.equal(result.saved_existing, true);
    assert.equal(result.save_callback_confirmed, true);
    assert.equal(result.retry_safe, true);
    assert.deepEqual(calls, [
      'tab_list', 'get_bound_client', 'evaluate',
      'pane_indicator_signatures', 'save',
      'evaluate', 'pane_indicator_signatures',
    ]);
    assert.equal(expressions.some((expression) => /saveChartAs|loadChartFromServer|Page\.navigate|setLayout|setSymbol|setResolution|\.click\(/u.test(expression)), false);
  } finally {
    await invalidateObserverSession();
  }
});

test('scoped save fails before effect on target or parity drift', async () => {
  await bindObserverSession({ managerBaseUrl: 'http://127.0.0.1:8080/api', profileId, cdpUrl: 'http://127.0.0.1:9222', chartTargetId: targetId, chartTargetUrl: canonicalUrl });
  try {
    const mismatched = makeDeps();
    await assert.rejects(
      saveExistingChartScopedV2({ ...input(), chart_target_id: 'other-target', _deps: mismatched.deps }),
      /target or profile does not match/,
    );
    assert.deepEqual(mismatched.calls, ['tab_list']);

    const driftedEvidence = evidence();
    driftedEvidence.signatures.panes[0].signature = 'b'.repeat(64);
    const drifted = makeDeps({ signatures: driftedEvidence.signatures });
    await assert.rejects(
      saveExistingChartScopedV2({ ...input(), _deps: drifted.deps }),
      /parity does not match expected authority/,
    );
    assert.equal(drifted.calls.includes('save'), false);
  } finally {
    await invalidateObserverSession();
  }
});

test('ambiguous save transport failure is explicitly retry-safe', async () => {
  await bindObserverSession({ managerBaseUrl: 'http://127.0.0.1:8080/api', profileId, cdpUrl: 'http://127.0.0.1:9222', chartTargetId: targetId, chartTargetUrl: canonicalUrl });
  try {
    let attempts = 0;
    const first = makeDeps({ save: async () => { attempts += 1; throw new Error('transport lost after request'); } });
    await assert.rejects(
      saveExistingChartScopedV2({ ...input(), _deps: first.deps }),
      (error) => error instanceof ScopedExistingChartSaveError
        && error.saveInvoked === true
        && error.effectState === 'ambiguous'
        && error.retrySafe === true,
    );
    const second = makeDeps({ save: async () => { attempts += 1; return { success: true, uid: chartId }; } });
    const result = await saveExistingChartScopedV2({ ...input(), _deps: second.deps });
    assert.equal(result.retry_safe, true);
    assert.equal(attempts, 2);
  } finally {
    await invalidateObserverSession();
  }
});
