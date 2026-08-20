import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  deriveLayoutIdFromMetaInfo,
  inspectSavedLayoutIdentity,
  probeExistingChartSaveCapability,
  probeExistingChartSaveCapabilityV2,
  saveExistingChartScoped,
  saveExistingChartScopedV2,
} from '../src/core/chart.js';
import { derivePaneIndicatorParityHash } from '../src/core/pane.js';
import { clearObserverSession, setObserverSession } from '../src/core/observer-session.js';
import { deriveLegacyLayoutIdFromSources, LEGACY_LAYOUT_IDENTITY_HELPER } from '../src/core/layout-identity.js';

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

test('layout ID extraction supports function/object/observable metaInfo forms', () => {
  assert.equal(deriveLayoutIdFromMetaInfo(() => ({ uid: 'layout-function' })), 'layout-function');
  assert.equal(deriveLayoutIdFromMetaInfo({ uid: 'layout-object' }), 'layout-object');
  assert.equal(deriveLayoutIdFromMetaInfo({ uid: { value: () => 'layout-observable' } }), 'layout-observable');
  assert.equal(deriveLayoutIdFromMetaInfo({ uid: { value: 'layout-value' } }), 'layout-value');
  assert.equal(deriveLayoutIdFromMetaInfo({ uid: 'wrong' }), 'wrong');
  assert.equal(deriveLayoutIdFromMetaInfo(null), null);
});

test('legacy workspace layout ignores layout type and uses historical collection/active identity', () => {
  assert.deepEqual(deriveLegacyLayoutIdFromSources({
    collection: { _layoutType: 8, _layoutId: 4 },
    active: { layoutId: 4 },
  }), { layout_id: '4' });
});

test('legacy workspace layout accepts one agreed collection and active identity', () => {
  assert.deepEqual(deriveLegacyLayoutIdFromSources({
    collection: { layoutId: '8' },
    active: { _layoutId: 8 },
  }), { layout_id: '8' });
});

test('legacy workspace layout rejects collection and active disagreement', () => {
  assert.match(deriveLegacyLayoutIdFromSources({
    collection: { _layoutId: 8 },
    active: { layoutId: 4 },
  }).error, /missing or ambiguous/);
});

test('legacy workspace layout unwraps function and observable values consistently', () => {
  assert.deepEqual(deriveLegacyLayoutIdFromSources({
    collection: { _layoutId: () => ({ value: () => 8 }) },
    active: { _layoutId: { value: 8 } },
  }), { layout_id: '8' });
});

test('browser layout helper matches shared legacy derivation semantics', () => {
  const browserDerive = (api) => vm.runInNewContext(`(function() {
    ${LEGACY_LAYOUT_IDENTITY_HELPER}
    return deriveLegacyLayoutId(api);
  })()`, { api });
  const api = {
    _chartWidgetCollection: { _layoutType: 8, _layoutId: { value: () => 4 } },
    _activeChartWidgetWV: { value: () => ({ _layoutId: 4 }) },
  };
  assert.equal(JSON.stringify(browserDerive(api)), JSON.stringify(deriveLegacyLayoutIdFromSources({
    collection: api._chartWidgetCollection,
    active: { _layoutId: { value: () => 4 } },
  })));
});

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
            ? { href: targetUrl, pane_count: 2, layout_id: 'layout-x', chart_available: true, save_service_available: true, save_existent_chart_type: 'function' }
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
    assert.deepEqual({
      save_invoked: result.save_invoked,
      effect_state: result.effect_state,
      effect_phase: result.effect_phase,
      save_callback_confirmed: result.save_callback_confirmed,
    }, {
      save_invoked: true,
      effect_state: 'confirmed',
      effect_phase: 'post-save-verification',
      save_callback_confirmed: true,
    });
    assert.match(saveExpression, /saveExistentChart/);
    assert.doesNotMatch(saveExpression, /saveNewChart|saveChartAs|renameChart|setLayout/);
  } finally {
    clearObserverSession();
  }
});

test('dual identity read-only surface keeps workspace layout separate from saved UID', async () => {
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp',
    chartTargetId: 'target-a',
    chartTargetUrl: targetUrl,
  });
  try {
    let expression = '';
    const result = await inspectSavedLayoutIdentity({
      profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a',
      expected_chart_id: 'chart-x', expected_workspace_layout_id: '8', expected_saved_layout_uid: 'chart-x', expected_pane_count: 2,
      _deps: {
        listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
        getBoundClient: async () => ({}),
        evaluate: async (value) => {
          expression = value;
          return {
            href: targetUrl, canonical_url: targetUrl, chart_id: 'chart-x', workspace_layout_id: '8', saved_layout_uid: 'chart-x',
            pane_count: 2, chart_available: true,
          };
        },
      },
    });
    assert.deepEqual(result, {
      success: true,
      identity_version: 'chart-saved-layout-identity-v1',
      profile_id: 'profile-a', chart_target_id: 'target-a', workspace_layout_id: '8', saved_layout_uid: 'chart-x',
      chart_id: 'chart-x', canonical_url: targetUrl, pane_count: 2, mutations_performed: false,
    });
    assert.doesNotMatch(expression, /saveExistentChart\s*\(|loadChartFromServer|Page\.navigate|setLayout|setSymbol|setResolution/);
  } finally {
    clearObserverSession();
  }
});

test('v2 capability probe reports both identities and never invokes save', async () => {
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp',
    chartTargetId: 'target-a',
    chartTargetUrl: targetUrl,
  });
  try {
    let expression = '';
    const result = await probeExistingChartSaveCapabilityV2({
      profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a',
      expected_chart_id: 'chart-x', expected_workspace_layout_id: '8', expected_saved_layout_uid: 'chart-x', expected_pane_count: 2,
      _deps: {
        listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
        getBoundClient: async () => ({}),
        evaluate: async (value) => {
          expression = value;
          return {
            href: targetUrl, canonical_url: targetUrl, chart_id: 'chart-x', workspace_layout_id: '8', saved_layout_uid: 'chart-x',
            pane_count: 2, chart_available: true, meta_info_type: 'object', meta_info_shape: 'object', uid_shape: 'string',
            save_service_available: true, save_existent_chart_type: 'function',
          };
        },
      },
    });
    assert.equal(result.workspace_layout_id, '8');
    assert.equal(result.saved_layout_uid, 'chart-x');
    assert.equal(result.chart_id, 'chart-x');
    assert.equal(result.mutations_performed, false);
    assert.equal(result.save_capability_available, true);
    assert.doesNotMatch(expression, /_layoutType/);
    assert.doesNotMatch(expression, /saveExistentChart\s*\(|loadChartFromServer|Page\.navigate|setLayout|setSymbol|setResolution/);
  } finally {
    clearObserverSession();
  }
});

test('v2 scoped save binds workspace layout and saved UID independently', async () => {
  const parityHash = derivePaneIndicatorParityHash({ paneCapacity: 2, canonicalPaneIndex: 0, panes: signatures.panes });
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
    const result = await saveExistingChartScopedV2({
      profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', expected_chart_id: 'chart-x',
      expected_workspace_layout_id: '8', expected_saved_layout_uid: 'chart-x', expected_pane_count: 2,
      expected_indicator_parity_hash: parityHash,
      _deps: {
        listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
        getBoundClient: async () => ({}),
        evaluate: async () => {
          evaluateCalls += 1;
          return {
            href: targetUrl, canonical_url: targetUrl, chart_id: 'chart-x', workspace_layout_id: '8', saved_layout_uid: 'chart-x',
            pane_count: 2, chart_available: true, save_service_available: true, save_existent_chart_type: 'function',
          };
        },
        evaluateAsync: async (expression) => {
          saveExpression = expression;
          return { success: true, explicit_uid: 'chart-x' };
        },
        inspectInventory: async () => ({ success: true, pane_count: 2, panes: [
          { index: 0, indicators: [{ get_study_by_id_resolves: true }] },
          { index: 1, indicators: [{ get_study_by_id_resolves: true }] },
        ] }),
        inspectSignatures: async () => signatures,
      },
    });
    assert.equal(evaluateCalls, 2);
    assert.equal(result.save_version, 'chart-save-existing-scoped-v2');
    assert.equal(result.workspace_layout_id, '8');
    assert.equal(result.saved_layout_uid, 'chart-x');
    assert.equal(result.chart_id, 'chart-x');
    assert.equal(result.effect_state, 'confirmed');
    assert.match(saveExpression, /saveExistentChart/);
    assert.match(saveExpression, /typeof value === 'string'/);
    assert.match(saveExpression, /value\.uid/);
    assert.doesNotMatch(saveExpression, /saveNewChart|saveChartAs|renameChart|setLayout/);
  } finally {
    clearObserverSession();
  }
});

test('v2 scoped save accepts direct or absent callback UID after exact post verification', async () => {
  const parityHash = derivePaneIndicatorParityHash({ paneCapacity: 2, canonicalPaneIndex: 0, panes: signatures.panes });
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api', profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp', chartTargetId: 'target-a', chartTargetUrl: targetUrl,
  });
  try {
    for (const callbackResult of [
      { success: true, explicit_uid: 'chart-x' },
      { success: true, explicit_uid: null },
    ]) {
      const result = await saveExistingChartScopedV2({
        profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', expected_chart_id: 'chart-x',
        expected_workspace_layout_id: '8', expected_saved_layout_uid: 'chart-x', expected_pane_count: 2,
        expected_indicator_parity_hash: parityHash,
        _deps: {
          listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
          getBoundClient: async () => ({}),
          evaluate: async () => ({ href: targetUrl, canonical_url: targetUrl, chart_id: 'chart-x', workspace_layout_id: '8', saved_layout_uid: 'chart-x', pane_count: 2, chart_available: true, save_service_available: true, save_existent_chart_type: 'function' }),
          evaluateAsync: async () => callbackResult,
          inspectInventory: async () => ({ success: true, pane_count: 2, panes: [{ index: 0, indicators: [{ get_study_by_id_resolves: true }] }, { index: 1, indicators: [{ get_study_by_id_resolves: true }] }] }),
          inspectSignatures: async () => signatures,
        },
      });
      assert.equal(result.saved_layout_uid, 'chart-x');
      assert.equal(result.effect_state, 'confirmed');
    }
  } finally {
    clearObserverSession();
  }
});

test('v2 scoped save rejects explicit conflicting callback UID as ambiguous', async () => {
  const parityHash = derivePaneIndicatorParityHash({ paneCapacity: 2, canonicalPaneIndex: 0, panes: signatures.panes });
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api', profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp', chartTargetId: 'target-a', chartTargetUrl: targetUrl,
  });
  try {
    await assert.rejects(
      saveExistingChartScopedV2({
        profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', expected_chart_id: 'chart-x',
        expected_workspace_layout_id: '8', expected_saved_layout_uid: 'chart-x', expected_pane_count: 2,
        expected_indicator_parity_hash: parityHash,
        _deps: {
          listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
          getBoundClient: async () => ({}),
          evaluate: async () => ({ href: targetUrl, canonical_url: targetUrl, chart_id: 'chart-x', workspace_layout_id: '8', saved_layout_uid: 'chart-x', pane_count: 2, chart_available: true, save_service_available: true, save_existent_chart_type: 'function' }),
          evaluateAsync: async () => ({ success: true, explicit_uid: 'other-chart' }),
          inspectInventory: async () => ({ success: true, pane_count: 2, panes: [{ index: 0, indicators: [{ get_study_by_id_resolves: true }] }, { index: 1, indicators: [{ get_study_by_id_resolves: true }] }] }),
          inspectSignatures: async () => signatures,
        },
      }),
      (error) => {
        assert.equal(error.name, 'ScopedSaveEffectError');
        assert.equal(error.effectState, 'ambiguous');
        assert.equal(error.phase, 'save-callback');
        return true;
      },
    );
  } finally {
    clearObserverSession();
  }
});

test('v2 scoped save rejects post-save saved UID drift after callback success', async () => {
  const parityHash = derivePaneIndicatorParityHash({ paneCapacity: 2, canonicalPaneIndex: 0, panes: signatures.panes });
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api', profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp', chartTargetId: 'target-a', chartTargetUrl: targetUrl,
  });
  try {
    let evaluateCalls = 0;
    await assert.rejects(
      saveExistingChartScopedV2({
        profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', expected_chart_id: 'chart-x',
        expected_workspace_layout_id: '8', expected_saved_layout_uid: 'chart-x', expected_pane_count: 2,
        expected_indicator_parity_hash: parityHash,
        _deps: {
          listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
          getBoundClient: async () => ({}),
          evaluate: async () => {
            evaluateCalls += 1;
            return { href: targetUrl, canonical_url: targetUrl, chart_id: 'chart-x', workspace_layout_id: '8', saved_layout_uid: evaluateCalls === 1 ? 'chart-x' : 'other-chart', pane_count: 2, chart_available: true, save_service_available: true, save_existent_chart_type: 'function' };
          },
          evaluateAsync: async () => ({ success: true, explicit_uid: null }),
          inspectInventory: async () => ({ success: true, pane_count: 2, panes: [{ index: 0, indicators: [{ get_study_by_id_resolves: true }] }, { index: 1, indicators: [{ get_study_by_id_resolves: true }] }] }),
          inspectSignatures: async () => signatures,
        },
      }),
      (error) => {
        assert.equal(error.name, 'ScopedSaveEffectError');
        assert.equal(error.saveInvoked, true);
        assert.equal(error.effectState, 'ambiguous');
        return true;
      },
    );
  } finally {
    clearObserverSession();
  }
});

test('v2 scoped save rejects independent workspace-layout drift before save', async () => {
  const parityHash = derivePaneIndicatorParityHash({ paneCapacity: 2, canonicalPaneIndex: 0, panes: signatures.panes });
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api', profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp', chartTargetId: 'target-a', chartTargetUrl: targetUrl,
  });
  try {
    await assert.rejects(
      saveExistingChartScopedV2({
        profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', expected_chart_id: 'chart-x',
        expected_workspace_layout_id: '8', expected_saved_layout_uid: 'chart-x', expected_pane_count: 2,
        expected_indicator_parity_hash: parityHash,
        _deps: {
          listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
          getBoundClient: async () => ({}),
          evaluate: async () => ({ href: targetUrl, canonical_url: targetUrl, chart_id: 'chart-x', workspace_layout_id: '4', saved_layout_uid: 'chart-x', pane_count: 2, chart_available: true }),
          evaluateAsync: async () => { throw new Error('save must not run'); },
        },
      }),
      /Dual saved-layout identity does not match reviewed authority/,
    );
  } finally {
    clearObserverSession();
  }
});

test('v2 scoped save rejects independent saved UID drift before save', async () => {
  const parityHash = derivePaneIndicatorParityHash({ paneCapacity: 2, canonicalPaneIndex: 0, panes: signatures.panes });
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api', profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp', chartTargetId: 'target-a', chartTargetUrl: targetUrl,
  });
  try {
    await assert.rejects(
      saveExistingChartScopedV2({
        profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', expected_chart_id: 'chart-x',
        expected_workspace_layout_id: '8', expected_saved_layout_uid: 'chart-x', expected_pane_count: 2,
        expected_indicator_parity_hash: parityHash,
        _deps: {
          listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
          getBoundClient: async () => ({}),
          evaluate: async () => ({ href: targetUrl, canonical_url: targetUrl, chart_id: 'chart-x', workspace_layout_id: '8', saved_layout_uid: 'other-chart', pane_count: 2, chart_available: true }),
          evaluateAsync: async () => { throw new Error('save must not run'); },
        },
      }),
      /Dual saved-layout identity does not match reviewed authority/,
    );
  } finally {
    clearObserverSession();
  }
});

test('scoped save classifies pre-effect failures without invoking save', async () => {
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
        profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', chart_id: 'chart-x', layout_id: 'layout-x',
        expected_pane_count: 2, expected_indicator_parity_hash: 'a'.repeat(64),
        _deps: {
          listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
          getBoundClient: async () => ({}),
          evaluate: async () => ({ href: targetUrl, pane_count: 2, layout_id: 'wrong', chart_available: true }),
          evaluateAsync: async () => { throw new Error('save must not run'); },
        },
      }),
      (error) => {
        assert.equal(error.name, 'ScopedSaveEffectError');
        assert.equal(error.saveInvoked, false);
        assert.equal(error.effectState, 'not-started');
        assert.equal(error.phase, 'pre-effect');
        return true;
      },
    );
  } finally {
    clearObserverSession();
  }
});

test('scoped save classifies post-invocation failures as ambiguous', async () => {
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
        profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', chart_id: 'chart-x', layout_id: 'layout-x',
        expected_pane_count: 2, expected_indicator_parity_hash: derivePaneIndicatorParityHash({ paneCapacity: 2, canonicalPaneIndex: 0, panes: signatures.panes }),
        _deps: {
          listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
          getBoundClient: async () => ({}),
          evaluate: async () => ({ href: targetUrl, pane_count: 2, layout_id: 'layout-x', chart_available: true, save_service_available: true, save_existent_chart_type: 'function' }),
          evaluateAsync: async () => { throw new Error('remote outcome unknown'); },
          inspectInventory: async () => ({ success: true, pane_count: 2, panes: [{ index: 0, indicators: [{ get_study_by_id_resolves: true }] }, { index: 1, indicators: [{ get_study_by_id_resolves: true }] }] }),
          inspectSignatures: async () => signatures,
        },
      }),
      (error) => {
        assert.equal(error.name, 'ScopedSaveEffectError');
        assert.equal(error.saveInvoked, true);
        assert.equal(error.effectState, 'ambiguous');
        assert.equal(error.phase, 'save-invocation');
        return true;
      },
    );
  } finally {
    clearObserverSession();
  }
});

test('scoped save classifies post-save verification failure as confirmed', async () => {
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp',
    chartTargetId: 'target-a',
    chartTargetUrl: targetUrl,
  });
  try {
    let evaluateCalls = 0;
    await assert.rejects(
      saveExistingChartScoped({
        profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', chart_id: 'chart-x', layout_id: 'layout-x',
        expected_pane_count: 2, expected_indicator_parity_hash: derivePaneIndicatorParityHash({ paneCapacity: 2, canonicalPaneIndex: 0, panes: signatures.panes }),
        _deps: {
          listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
          getBoundClient: async () => ({}),
          evaluate: async () => {
            evaluateCalls += 1;
            if (evaluateCalls === 1) return { href: targetUrl, pane_count: 2, layout_id: 'layout-x', chart_available: true, save_service_available: true, save_existent_chart_type: 'function' };
            throw new Error('post target read failed');
          },
          evaluateAsync: async () => ({ success: true, uid: 'layout-x' }),
          inspectInventory: async () => ({ success: true, pane_count: 2, panes: [{ index: 0, indicators: [{ get_study_by_id_resolves: true }] }, { index: 1, indicators: [{ get_study_by_id_resolves: true }] }] }),
          inspectSignatures: async () => signatures,
        },
      }),
      (error) => {
        assert.equal(error.name, 'ScopedSaveEffectError');
        assert.equal(error.saveInvoked, true);
        assert.equal(error.effectState, 'confirmed');
        assert.equal(error.phase, 'post-save-verification');
        assert.equal(error.saveCallbackConfirmed, true);
        return true;
      },
    );
  } finally {
    clearObserverSession();
  }
});

test('missing save service is classified before effect invocation', async () => {
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
        profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', chart_id: 'chart-x', layout_id: 'layout-x',
        expected_pane_count: 2, expected_indicator_parity_hash: 'a'.repeat(64),
        _deps: {
          listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
          getBoundClient: async () => ({}),
          evaluate: async () => ({ href: targetUrl, pane_count: 2, layout_id: 'layout-x', chart_available: true, save_service_available: false, save_existent_chart_type: 'missing' }),
          evaluateAsync: async () => { throw new Error('save must not run'); },
        },
      }),
      (error) => {
        assert.equal(error.name, 'ScopedSaveEffectError');
        assert.equal(error.saveInvoked, false);
        assert.equal(error.effectState, 'not-started');
        assert.equal(error.phase, 'pre-effect');
        return true;
      },
    );
  } finally {
    clearObserverSession();
  }
});

test('read-only save capability probe never invokes save and reports persisted parity authority unavailable', async () => {
  setObserverSession({
    managerBaseUrl: 'http://127.0.0.1:8080/api',
    profileId: 'profile-a',
    cdpUrl: 'http://127.0.0.1:8080/api/profiles/profile-a/cdp',
    chartTargetId: 'target-a',
    chartTargetUrl: targetUrl,
  });
  try {
    let expression = '';
    const result = await probeExistingChartSaveCapability({
      profile_id: 'profile-a', tab_index: 0, chart_target_id: 'target-a', chart_id: 'chart-x', layout_id: 'layout-x', expected_pane_count: 2,
      _deps: {
        listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-x', url: targetUrl }] }),
        getBoundClient: async () => ({}),
        evaluate: async (value) => {
          expression = value;
          return {
            href: targetUrl, pane_count: 2, layout_id: 'layout-x', chart_available: true,
            meta_info_type: 'object', meta_info_shape: 'object', uid_shape: 'string',
            save_service_available: true, save_existent_chart_type: 'function',
          };
        },
      },
    });
    assert.equal(result.mutations_performed, false);
    assert.equal(result.persisted_state_authority, 'unavailable');
    assert.match(expression, /saveExistentChart/);
    assert.doesNotMatch(expression, /saveExistentChart\s*\(/);
    assert.doesNotMatch(expression, /loadChartFromServer|Page\.navigate|setLayout|setSymbol|setResolution/);
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
