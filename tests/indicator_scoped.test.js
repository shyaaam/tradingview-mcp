/**
 * Scoped indicator mutation unit tests — no TradingView connection needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyScopedBlueprintIndicator, applyScopedPlanItem, removeScopedIndicator, updateScopedSettings, verifyScopedMutationAuthority } from '../src/core/indicators.js';
import { activateBoundTarget } from '../src/core/tab.js';

const TARGET_URL = 'https://www.tradingview.com/chart/chart-1/';

function makeAuthorityDeps({ tabs = [{ index: 0, id: 'target-1', chart_id: 'chart-1', url: TARGET_URL }], layoutId = '8', paneSignature = 'a'.repeat(64) } = {}) {
  return {
    getObserverSession: () => ({ profileId: 'profile-a', chartTargetId: 'target-1' }),
    resolveManagerBaseUrl: async () => 'http://manager.test/',
    async fetch() { return { ok: true, async json() { return [{ id: 'profile-a', status: 'running' }]; } }; },
    async listTabs() { return { success: true, tabs }; },
    async evaluate() { return { layout_id: layoutId }; },
    async indicatorSignatures() {
      return { panes: [{ index: 2, signature: paneSignature, indicators: [] }] };
    },
  };
}

const reviewedAuthority = {
  profile_id: 'profile-a', tab_index: 1, pane_index: 2,
  indicator_name: 'Reviewed Study', expected_chart_target_id: 'target-1',
  expected_chart_id: 'chart-1', expected_layout_id: '8',
  expected_pane_signature: 'a'.repeat(64),
};

describe('exact bound-target activation', () => {
  it('brings bound CDP target forward without resolving a positional tab index', async () => {
    const calls = [];
    const targetUrl = 'https://www.tradingview.com/chart/chart-b/';
    const result = await activateBoundTarget({
      expected_chart_target_id: 'target-b',
      _deps: {
        getObserverSession: () => ({ chartTargetId: 'target-b', chartTargetUrl: targetUrl }),
        async getBoundClient() {
          calls.push('bound-client');
          return { Page: { async bringToFront() { calls.push('bring-to-front'); } } };
        },
        async getTargetInfo() { return { id: 'target-b', url: targetUrl }; },
        async listTabs() { throw new Error('positional tab listing must not select activation target'); },
      },
    });
    assert.deepEqual(calls, ['bound-client', 'bring-to-front']);
    assert.equal(result.tab_id, 'target-b');
  });

  it('fails closed if bound CDP target URL differs from session authority', async () => {
    let broughtToFront = false;
    await assert.rejects(() => activateBoundTarget({
      expected_chart_target_id: 'target-b',
      _deps: {
        getObserverSession: () => ({ chartTargetId: 'target-b', chartTargetUrl: 'https://www.tradingview.com/chart/chart-b/' }),
        async getBoundClient() { return { Page: { async bringToFront() { broughtToFront = true; } } }; },
        async getTargetInfo() { return { id: 'target-b', url: 'https://www.tradingview.com/chart/wrong/' }; },
      },
    }), /does not match reviewed chart authority/);
    assert.equal(broughtToFront, false);
  });
});

describe('scoped mutation target authority', () => {
  it('accepts exact target after it moves from index 1 to 0; ignores wrong target at old index', async () => {
    const deps = makeAuthorityDeps({ tabs: [
      { index: 0, id: 'target-1', chart_id: 'chart-1', url: TARGET_URL },
      { index: 1, id: 'other-target', chart_id: 'other-chart', url: 'https://www.tradingview.com/chart/other-chart/' },
    ] });
    const scope = await verifyScopedMutationAuthority(reviewedAuthority, { _deps: deps });
    assert.equal(scope.expected_chart_target_id, 'target-1');
    assert.equal(scope.tab_index, 1); // retained as provenance, not authority
  });

  it('fails closed when exact target is absent or duplicated', async (t) => {
    await t.test('absent', async () => {
      const deps = makeAuthorityDeps({ tabs: [{ index: 0, id: 'other-target', chart_id: 'chart-1', url: TARGET_URL }] });
      await assert.rejects(() => verifyScopedMutationAuthority(reviewedAuthority, { _deps: deps }), /target tab identity is not unique/);
    });
    await t.test('duplicate', async () => {
      const deps = makeAuthorityDeps({ tabs: [
        { index: 0, id: 'target-1', chart_id: 'chart-1', url: TARGET_URL },
        { index: 1, id: 'target-1', chart_id: 'chart-1', url: TARGET_URL },
      ] });
      await assert.rejects(() => verifyScopedMutationAuthority(reviewedAuthority, { _deps: deps }), /target tab identity is not unique/);
    });
  });

  it('fails closed when exact target chart identity or layout differs', async (t) => {
    await t.test('chart id', async () => {
      const deps = makeAuthorityDeps({ tabs: [{ index: 0, id: 'target-1', chart_id: 'other-chart', url: TARGET_URL }] });
      await assert.rejects(() => verifyScopedMutationAuthority(reviewedAuthority, { _deps: deps }), /chart identity does not match/);
    });
    await t.test('chart URL', async () => {
      const deps = makeAuthorityDeps({ tabs: [{ index: 0, id: 'target-1', chart_id: 'chart-1', url: 'https://www.tradingview.com/chart/wrong-url/' }] });
      await assert.rejects(() => verifyScopedMutationAuthority(reviewedAuthority, { _deps: deps }), /chart identity does not match/);
    });
    await t.test('layout', async () => {
      const deps = makeAuthorityDeps({ layoutId: '4' });
      await assert.rejects(() => verifyScopedMutationAuthority(reviewedAuthority, { _deps: deps }), /layout identity does not match/);
    });
    await t.test('pane signature', async () => {
      const deps = makeAuthorityDeps({ paneSignature: 'b'.repeat(64) });
      await assert.rejects(() => verifyScopedMutationAuthority(reviewedAuthority, { _deps: deps }), /pre-mutation pane signature/);
    });
  });
});

function makeDeps({ studies = [], failActivation = false, failFocus = false, canonicalPriceStudy = false, canonicalSourceCount = 1, fallbackNameOverride, fallbackPaneOffset = 0 } = {}) {
  const state = {
    studies: studies.map(study => ({ id: study.id, indicatorId: study.indicatorId || study.id, name: study.name, isPriceStudy: study.isPriceStudy === true, inputs: (study.inputs || []).map(input => ({ ...input })), values: study.values ? { ...study.values } : undefined })),
    tabTargets: [{ index: 0, id: 'other-target' }, { index: 1, id: 'target-1' }],
    selectedTargetId: null, activatedTargetIds: [], switchedTabs: [], focusedPanes: [], created: [], evaluateCalls: [], evaluateOptions: [], canonicalPriceStudy,
    canonicalSourceCount, fallbackNameOverride, fallbackPaneOffset, byNameCreateCalls: 0, activePane: null,
  };
  return {
    state,
    deps: {
      async verifyMutationAuthority() {},
      async switchTab({ index }) { state.switchedTabs.push(index); state.selectedTargetId = state.tabTargets[index]?.id ?? null; return { success: true, action: 'switched', index, tab_id: state.selectedTargetId }; },
      async activateBoundTarget({ expected_chart_target_id }) { if (failActivation) throw new Error('bound target activation failed'); state.activatedTargetIds.push(expected_chart_target_id); state.selectedTargetId = expected_chart_target_id; return { success: true, action: 'activated', tab_id: expected_chart_target_id }; },
      async focusPane({ index }) { if (failFocus) throw new Error('pane target ambiguous'); state.focusedPanes.push(index); state.activePane = index; return { success: true, focused_index: index, total: 8 }; },
      async indicatorSignatures() {
        return {
          panes: Array.from({ length: 8 }, (_, index) => ({
            index,
            signature: 'a'.repeat(64),
            indicators: state.studies.filter((study) => study.pane_index === undefined || study.pane_index === index).map((study) => ({
              indicator_id: study.indicatorId,
              entity_id: study.id,
              indicator_name: study.name,
              is_price_study: study.isPriceStudy,
              settings: {},
            })),
          })),
        };
      },
      async evaluate(expression, options = {}) {
        state.evaluateCalls.push(expression);
        state.evaluateOptions.push(options);
        if (expression.includes('getAllStudies') && expression.includes('return null')) {
          const name = expression.match(/name === "([^"]+)"/)?.[1] || '';
          const matching = state.studies.filter(study => (study.pane_index === undefined || study.pane_index === state.activePane)
            && study.name.toLowerCase() === name);
          if (matching.length > 1) return { error: `scoped indicator mutation found duplicate matching studies: ${name}` };
          const found = matching[0];
          return found ? { id: found.id, name: found.name, inputs: found.inputs, values: found.values } : null;
        }
        if (expression.includes('var canonicalMatches')) {
          const name = expression.match(/chart\.createStudy\("([^"]+)"/)?.[1]
            || expression.match(/scoped indicator add found multiple canonical pane indicators: ' \+ "([^"]+)"/)?.[1]
            || '';
          if (state.canonicalSourceCount > 1) {
            return { error: `scoped indicator add found multiple canonical pane indicators: ${name}` };
          }
          if (state.canonicalSourceCount === 0) {
            state.byNameCreateCalls += 1;
            const createdName = state.fallbackNameOverride || name;
            const id = `study-${state.studies.length + 1}`;
            const settingsMatch = expression.match(/var expectedSettings = ([\s\S]*?);\s+var canonicalMeta/);
            const rawSettings = settingsMatch ? JSON.parse(settingsMatch[1]) : {};
            const inputs = Object.entries(rawSettings).map(([key, value]) => ({
              id: key,
              value: value && typeof value === 'object' && !Array.isArray(value)
                && Object.prototype.hasOwnProperty.call(value, 'v')
                && Object.keys(value).every((field) => field === 'f' || field === 't' || field === 'v')
                ? value.v
                : value,
            }));
            const study = { id, indicatorId: `id:${createdName}`, name: createdName, isPriceStudy: false, inputs, pane_index: state.activePane + state.fallbackPaneOffset };
            state.studies.push(study);
            state.created.push({ ...study });
            if (createdName.toLowerCase() !== name.toLowerCase()) {
              return { error: 'scoped indicator add resolved an unexpected study name' };
            }
            return { id, name: createdName, inputs };
          }
        }
        if (expression.includes('chart.createStudy(') && !expression.includes('var canonicalMatches')) {
          const name = expression.match(/chart\.createStudy\("([^"]+)"/)?.[1] || '';
          const id = `study-${state.studies.length + 1}`;
          const indicatorId = name === 'Relative Strength Index' ? 'STD;RSI' : `id:${name}`;
          const settingsMatch = expression.match(/var rawSettings = ([\s\S]*?);\s+var inputs/);
          const rawSettings = settingsMatch ? JSON.parse(settingsMatch[1]) : {};
          const inputs = Object.entries(rawSettings).map(([key, value]) => ({
            id: key,
            value: value && typeof value === 'object' && !Array.isArray(value)
              && Object.prototype.hasOwnProperty.call(value, 'v')
              && Object.keys(value).every((field) => field === 'f' || field === 't' || field === 'v')
              ? value.v
              : value,
          }));
          state.studies.push({ id, indicatorId, name, isPriceStudy: false, inputs });
          state.created.push({ id, indicatorId, name, inputs });
          return { id, name, inputs };
        }
        if (expression.includes('insertStudyWithParams')) {
          if (state.canonicalPriceStudy && !expression.includes('forceOverlay: canonicalMeta.is_price_study === true')) {
            throw new Error('price-study insertion omitted forceOverlay');
          }
          const name = expression.includes('Private No-Input Study')
            ? 'Private No-Input Study'
            : 'Relative Strength Index';
          const id = `study-${state.studies.length + 1}`;
          const inputs = [{ id: 'length', value: 14 }];
          state.studies.push({ id, name, inputs }); state.created.push({ id, name, inputs });
          state.lastApplyMethod = 'canonical';
          return { id, name, inputs };
        }
        if (expression.includes('study.setInputValues')) {
          const id = expression.match(/chart.getStudyById\("([^"]+)"\)/)?.[1];
          const study = state.studies.find(item => item.id === id);
          if (!study) return { error: `Study not found: ${id}` };
          const previous = Object.fromEntries(study.inputs.map(input => [input.id, input.value]));
          study.inputs = study.inputs.map(input => ({ ...input, value: 50 }));
          return { id, previous, inputs: study.inputs, values: study.values };
        }
        if (expression.includes('removeEntity')) {
          const id = expression.match(/getStudyById\("([^"]+)"\)/)?.[1];
          const index = state.studies.findIndex((study) => study.id === id);
          if (index < 0) return { error: `Study not found: ${id}` };
          state.studies.splice(index, 1);
          return { id, removed: true };
        }
        throw new Error(`unexpected evaluate expression: ${expression.slice(0, 80)}`);
      },
    },
  };
}

describe('scoped indicator plan primitives', () => {
  it('activates exact reviewed target when stale index now belongs to another chart', async () => {
    const { deps, state } = makeDeps();
    await applyScopedPlanItem({
      profile_id: 'profile-a', tab_index: 0, pane_index: 2,
      indicator_name: 'Relative Strength Index', expected_settings: {}, action: 'apply_indicator',
      expected_chart_target_id: 'target-1', expected_chart_id: 'chart-1', expected_layout_id: '8',
      expected_pane_signature: 'a'.repeat(64), _deps: deps,
    });
    assert.equal(state.tabTargets[0].id, 'other-target');
    assert.equal(state.selectedTargetId, 'target-1');
    assert.deepEqual(state.activatedTargetIds, ['target-1']);
    assert.deepEqual(state.switchedTabs, []);
  });

  it('applies an indicator and returns scoped evidence', async () => {
    const { deps } = makeDeps();
    const result = await applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 2, indicator_name: 'Relative Strength Index', expected_settings: { length: 14 }, action: 'apply_indicator', _deps: deps });
    assert.equal(result.success, true);
    assert.deepEqual(result.previous_settings, {});
    assert.deepEqual(result.new_settings, { length: 14 });
  });

  it('allows scoped apply with empty settings for studies without exposed inputs', async () => {
    const { deps } = makeDeps();
    const result = await applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 2, indicator_name: 'Private No-Input Study', expected_settings: {}, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.post_mutation_indicator.indicator_name, 'Private No-Input Study');
  });

  it('uses canonical pane metadata for scoped Pine study insertion', async () => {
    const { deps, state } = makeDeps();
    await applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 2, indicator_name: 'Relative Strength Index', expected_settings: {}, _deps: deps });
    assert.ok(state.evaluateCalls.some((expression) => expression.includes('canonicalMatches')));
    assert.ok(state.evaluateCalls.some((expression) => expression.includes('insertStudyWithParams')));
    assert.ok(state.evaluateOptions.some((options) => options.awaitPromise === true));
    assert.equal(state.created.length, 1);
  });

  it('adds by reviewed name when blank chart has no canonical pane source', async () => {
    const { deps, state } = makeDeps({ canonicalSourceCount: 0 });
    const result = await applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 2, indicator_name: 'Relative Strength Index', expected_settings: { length: 14 }, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.post_mutation_indicator.indicator_name, 'Relative Strength Index');
    assert.equal(state.byNameCreateCalls, 1);
    assert.ok(state.evaluateOptions.some((options) => options.awaitPromise === true));
    assert.equal(state.lastApplyMethod, undefined);
    assert.deepEqual(state.created[0].inputs, [{ id: 'length', value: 14 }]);
  });

  it('fails closed on multiple canonical pane sources without creating a study', async () => {
    const { deps, state } = makeDeps({ canonicalSourceCount: 2 });
    await assert.rejects(
      () => applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 2, indicator_name: 'Relative Strength Index', expected_settings: {}, _deps: deps }),
      /multiple canonical pane indicators/,
    );
    assert.equal(state.byNameCreateCalls, 0);
    assert.equal(state.created.length, 0);
  });

  it('rejects by-name fallback when TradingView resolves a different study name', async () => {
    const { deps, state } = makeDeps({ canonicalSourceCount: 0, fallbackNameOverride: 'Unexpected Study' });
    await assert.rejects(
      () => applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 2, indicator_name: 'Relative Strength Index', expected_settings: {}, _deps: deps }),
      /unexpected study name/,
    );
    assert.equal(state.byNameCreateCalls, 1);
    assert.equal(state.created[0].name, 'Unexpected Study');
  });

  it('rejects by-name fallback when new study appears in a different pane', async () => {
    const { deps, state } = makeDeps({ canonicalSourceCount: 0, fallbackPaneOffset: 1 });
    await assert.rejects(
      () => applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 2, indicator_name: 'Relative Strength Index', expected_settings: {}, _deps: deps }),
      /did not produce exactly one post-mutation/,
    );
    assert.equal(state.byNameCreateCalls, 1);
    assert.equal(state.created[0].pane_index, 3);
  });

  it('uses forceOverlay for a canonical price-study insertion', async () => {
    const { deps, state } = makeDeps({ canonicalPriceStudy: true });
    let authorizedScope;
    deps.verifyMutationAuthority = async (scope) => { authorizedScope = scope; };
    await applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 4, pane_index: 2, indicator_name: 'Relative Strength Index', expected_chart_target_id: 'target-1', expected_chart_id: 'chart-1', expected_layout_id: '8', expected_pane_signature: 'a'.repeat(64), expected_settings: {}, action: 'apply_indicator', _deps: deps });
    assert.equal(state.canonicalPriceStudy, true);
    assert.ok(state.evaluateCalls.some((expression) => expression.includes('forceOverlay: canonicalMeta.is_price_study === true')));
    assert.deepEqual(authorizedScope, {
      profile_id: 'profile-a',
      tab_index: 4,
      pane_index: 2,
      indicator_name: 'Relative Strength Index',
      expected_chart_target_id: 'target-1',
      expected_chart_id: 'chart-1',
      expected_layout_id: '8',
      expected_pane_signature: 'a'.repeat(64),
    });
    assert.deepEqual(state.activatedTargetIds, ['target-1']);
    assert.deepEqual(state.switchedTabs, []);
    assert.deepEqual(state.focusedPanes, [2]);
    assert.equal(state.created.length, 1);
  });

  it('applies an approved blueprint indicator on a blank chart without a surviving canonical source', async () => {
    const { deps, state } = makeDeps();
    const result = await applyScopedBlueprintIndicator({
      profile_id: 'profile-a',
      tab_index: 0,
      pane_index: 0,
      indicator_id: 'STD;RSI',
      indicator_name: 'Relative Strength Index',
      expected_is_price_study: false,
      expected_chart_target_id: 'target-1',
      expected_chart_id: 'chart-1',
      expected_layout_id: '8',
      expected_pane_signature: 'a'.repeat(64),
      expected_post_pane_signature: 'a'.repeat(64),
      expected_settings: { length: { f: true, t: 'integer', v: 14 } },
      _deps: deps,
    });
    assert.equal(result.success, true);
    assert.equal(result.blueprint_apply_version, 'indicator-apply-blueprint-scoped-v1');
    assert.equal(result.indicator_id, 'STD;RSI');
    assert.equal(result.post_mutation_signature, 'a'.repeat(64));
    assert.ok(state.evaluateCalls.some((expression) => expression.includes('chart.createStudy(')));
    assert.ok(!state.evaluateCalls.some((expression) => expression.includes('canonicalMatches') && expression.includes('chart.createStudy(')));
    assert.equal(state.created.length, 1);
    assert.deepEqual(state.created[0].inputs, [{ id: 'length', value: 14 }]);
  });

  it('fails closed when blueprint createStudy resolves a different stable indicator ID', async () => {
    const { deps } = makeDeps();
    await assert.rejects(() => applyScopedBlueprintIndicator({
      profile_id: 'profile-a', tab_index: 0, pane_index: 0,
      indicator_id: 'expected-other-id', indicator_name: 'Relative Strength Index', expected_is_price_study: false,
      expected_chart_target_id: 'target-1', expected_chart_id: 'chart-1', expected_layout_id: '8',
      expected_pane_signature: 'a'.repeat(64), expected_post_pane_signature: 'a'.repeat(64), expected_settings: { length: 14 },
      _deps: deps,
    }), /stable ID does not match approved blueprint/);
  });

  it('fails closed when blueprint post-pane signature differs from the approved recovery step', async () => {
    const { deps } = makeDeps();
    await assert.rejects(() => applyScopedBlueprintIndicator({
      profile_id: 'profile-a', tab_index: 0, pane_index: 0,
      indicator_id: 'STD;RSI', indicator_name: 'Relative Strength Index', expected_is_price_study: false,
      expected_chart_target_id: 'target-1', expected_chart_id: 'chart-1', expected_layout_id: '8',
      expected_pane_signature: 'a'.repeat(64), expected_post_pane_signature: 'b'.repeat(64), expected_settings: { length: 14 },
      _deps: deps,
    }), /post-mutation pane signature does not match approved recovery step/);
  });

  it('updates indicator settings and returns previous/new scoped evidence', async () => {
    const { deps } = makeDeps({ studies: [{ id: 'study-rsi', name: 'RSI', inputs: [{ id: 'length', value: 14 }] }] });
    const result = await updateScopedSettings({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 50 }, _deps: deps });
    assert.deepEqual(result.previous_settings, { length: 14 });
    assert.deepEqual(result.new_settings, { length: 50 });
    assert.equal(result.previous_settings_source, 'input_values');
    assert.equal(result.new_settings_source, 'input_values');
  });

  it('returns displayed values for private studies without raw inputs', async () => {
    const { deps } = makeDeps({ studies: [{ id: 'study-private', name: 'Private Hermes Study', inputs: [], values: { Fast: '293.98', Slow: '291.61' } }] });
    const result = await updateScopedSettings({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'Private Hermes Study', expected_settings: { in_1: 25 }, _deps: deps });
    assert.deepEqual(result.previous_settings, { values: { Fast: '293.98', Slow: '291.61' } });
    assert.deepEqual(result.new_settings, { values: { Fast: '293.98', Slow: '291.61' } });
    assert.equal(result.previous_settings_source, 'displayed_values');
    assert.equal(result.new_settings_source, 'displayed_values');
  });

  it('returns diagnostics when scoped settings evidence is unavailable', async () => {
    const { deps } = makeDeps({ studies: [{ id: 'study-private', name: 'Private Empty Study', inputs: [] }] });
    const result = await updateScopedSettings({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'Private Empty Study', expected_settings: { in_1: 25 }, _deps: deps });
    assert.equal(result.previous_settings_source, 'unavailable');
    assert.equal(result.new_settings_source, 'unavailable');
    assert.deepEqual(result.settings_unavailable_reason, {
      previous_settings: 'study did not expose input values or displayed values',
      new_settings: 'study did not expose input values or displayed values',
    });
  });
  it('includes underlying property restoration when public input values are empty', async () => {
    const { deps, state } = makeDeps({ studies: [{ id: 'study-cvd', name: 'CVD', inputs: [] }] });
    await updateScopedSettings({ profile_id: 'profile-a', tab_index: 0, pane_index: 1, indicator_name: 'CVD', expected_settings: { in_11: 4278190208 }, _deps: deps });
    assert.ok(state.evaluateCalls.some((expression) => expression.includes('underlyingStudy') && expression.includes('inputProperties')));
  });

  it('blocks missing profile scope', async () => {
    await assert.rejects(() => applyScopedPlanItem({ profile_id: '', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 14 }, _deps: makeDeps().deps }), /profile_id is required/);
  });
  it('requires reviewed target and pane authority for direct production calls', async () => {
    await assert.rejects(() => applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 14 } }), /expected_chart_target_id is required/);
  });
  it('rejects duplicate same-name studies instead of selecting first match', async () => {
    const { deps } = makeDeps({ studies: [
      { id: 'study-rsi-1', name: 'RSI', inputs: [{ id: 'length', value: 14 }] },
      { id: 'study-rsi-2', name: 'RSI', inputs: [{ id: 'length', value: 14 }] },
    ] });
    await assert.rejects(() => updateScopedSettings({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 50 }, _deps: deps }), /duplicate matching studies/);
  });
  it('blocks failed exact bound-target activation', async () => {
    await assert.rejects(() => applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 14 }, _deps: makeDeps({ failActivation: true }).deps }), /bound target activation failed/);
  });
  it('blocks ambiguous pane target selection', async () => {
    await assert.rejects(() => applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 14 }, _deps: makeDeps({ failFocus: true }).deps }), /pane target ambiguous/);
  });
  it('blocks unsupported action', async () => {
    await assert.rejects(() => applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 14 }, action: 'delete_indicator', _deps: makeDeps().deps }), /unsupported scoped indicator action/);
  });
  it('blocks update when target indicator is missing', async () => {
    await assert.rejects(() => updateScopedSettings({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 14 }, _deps: makeDeps().deps }), /indicator not found for update/);
  });
  it('removes one exact scoped indicator and proves post-mutation absence', async () => {
    const { deps, state } = makeDeps({ studies: [{ id: 'study-rsi', name: 'RSI', inputs: [{ id: 'length', value: 14 }] }] });
    const result = await removeScopedIndicator({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_chart_target_id: 'target-1', expected_chart_id: 'chart-1', expected_layout_id: '8', expected_pane_signature: 'a'.repeat(64), expected_entity_id: 'study-rsi', _deps: deps });
    assert.equal(result.action, 'remove_indicator');
    assert.equal(result.post_mutation_indicator, null);
    assert.equal(state.studies.length, 0);
  });
  it('removes exact study from pane 1 after focusing pane 1', async () => {
    const { deps, state } = makeDeps({ studies: [{ id: 'volume-pane-1', name: 'Volume', pane_index: 1 }] });
    const result = await removeScopedIndicator({ profile_id: 'profile-a', tab_index: 0, pane_index: 1, indicator_name: 'Volume', expected_chart_target_id: 'target-1', expected_chart_id: 'chart-1', expected_layout_id: '8', expected_pane_signature: 'a'.repeat(64), expected_entity_id: 'volume-pane-1', _deps: deps });
    assert.equal(result.action, 'remove_indicator');
    assert.deepEqual(state.focusedPanes, [1]);
    assert.equal(state.studies.length, 0);
  });
  it('does not remove pane 1 study when reviewed entity identity differs', async () => {
    const { deps, state } = makeDeps({ studies: [{ id: 'volume-pane-1', name: 'Volume', pane_index: 1 }] });
    await assert.rejects(
      () => removeScopedIndicator({ profile_id: 'profile-a', tab_index: 0, pane_index: 1, indicator_name: 'Volume', expected_chart_target_id: 'target-1', expected_chart_id: 'chart-1', expected_layout_id: '8', expected_pane_signature: 'a'.repeat(64), expected_entity_id: 'wrong-volume-id', _deps: deps }),
      /entity ID does not match reviewed entity/,
    );
    assert.equal(state.studies.length, 1);
    assert.equal(state.evaluateCalls.some((expression) => expression.includes('removeEntity')), false);
  });
  it('rejects scoped removal without exact entity identity', async () => {
    await assert.rejects(() => removeScopedIndicator({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: {}, _deps: makeDeps().deps }), /expected_entity_id/);
  });
});
