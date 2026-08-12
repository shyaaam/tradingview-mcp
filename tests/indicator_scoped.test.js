/**
 * Scoped indicator mutation unit tests — no TradingView connection needed.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScopedIndicator,
  applyScopedPlanItem,
  readScopedIndicatorSignatures,
  removeScopedIndicator,
  updateScopedIndicatorSettings,
  updateScopedSettings,
} from '../src/core/indicators.js';

function makeDeps({ studies = [], failSwitch = false, failFocus = false } = {}) {
  const state = {
    studies: studies.map(study => ({ id: study.id, name: study.name, inputs: (study.inputs || []).map(input => ({ ...input })), values: study.values ? { ...study.values } : undefined })),
    switchedTabs: [], focusedPanes: [], created: [],
  };
  return {
    state,
    deps: {
      async switchTab({ index }) { if (failSwitch) throw new Error('tab target ambiguous'); state.switchedTabs.push(index); return { success: true, action: 'switched', index }; },
      async focusPane({ index }) { if (failFocus) throw new Error('pane target ambiguous'); state.focusedPanes.push(index); return { success: true, focused_index: index, total: 8 }; },
      async evaluate(expression) {
        if (expression.includes('getAllStudies') && expression.includes('return null')) {
          const name = expression.match(/name === "([^"]+)"/)?.[1] || '';
          const found = state.studies.find(study => study.name.toLowerCase() === name);
          return found ? { id: found.id, name: found.name, inputs: found.inputs, values: found.values } : null;
        }
        if (expression.includes('chart.createStudy')) {
          const name = expression.match(/chart.createStudy\("([^"]+)"/)?.[1] || 'Unknown';
          const id = `study-${state.studies.length + 1}`;
          const inputs = [{ id: 'length', value: 14 }];
          state.studies.push({ id, name, inputs }); state.created.push({ id, name, inputs });
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
        throw new Error(`unexpected evaluate expression: ${expression.slice(0, 80)}`);
      },
    },
  };
}

describe('scoped indicator plan primitives', () => {
  it('applies an indicator and returns scoped evidence', async () => {
    const { deps } = makeDeps();
    const result = await applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 2, indicator_name: 'Relative Strength Index', expected_settings: { length: 14 }, action: 'apply_indicator', _deps: deps });
    assert.equal(result.success, true);
    assert.deepEqual(result.previous_settings, {});
    assert.deepEqual(result.new_settings, { length: 14 });
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

  it('blocks missing profile scope', async () => {
    await assert.rejects(() => applyScopedPlanItem({ profile_id: '', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 14 }, _deps: makeDeps().deps }), /profile_id is required/);
  });
  it('blocks ambiguous tab target selection', async () => {
    await assert.rejects(() => applyScopedPlanItem({ profile_id: 'profile-a', tab_index: 0, pane_index: 0, indicator_name: 'RSI', expected_settings: { length: 14 }, _deps: makeDeps({ failSwitch: true }).deps }), /tab target ambiguous/);
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
});

function scopedDeps({ indicatorName = 'Relative Strength Index', entityId = 'study-1', include = true } = {}) {
  const state = {
    indicators: include ? [{
      indicator_id: 'RSI@tv-basicstudies', entity_id: entityId, indicator_name: indicatorName,
      is_price_study: false, settings: { length: 14 },
    }] : [],
  };
  const inventory = () => ({
    success: true,
    schema_version: 'pane-indicator-signatures-v1',
    pane_count: 1,
    canonical_pane_index: 0,
    panes: [{ index: 0, signature: state.indicators.length ? 'a'.repeat(64) : 'b'.repeat(64), indicators: state.indicators }],
  });
  const deps = {
    session: { profileId: 'profile-a', chartTargetId: 'target-a', chartTargetUrl: 'https://www.tradingview.com/chart/chart-a/' },
    async listTabs() {
      return { success: true, tabs: [{ index: 0, id: 'target-a', chart_id: 'chart-a', url: 'https://www.tradingview.com/chart/chart-a/' }] };
    },
    async switchTab() { return { success: true, action: 'switched', index: 0 }; },
    async focusPane() { return { success: true, focused_index: 0, total_panes: 1 }; },
    async indicatorSignatures() { return inventory(); },
    async evaluate(expression) {
      if (expression.includes('layout_id')) return { layout_id: '8' };
      if (expression.includes('chart.createStudy')) {
        state.indicators.push({ indicator_id: 'RSI@tv-basicstudies', entity_id: 'study-new', indicator_name: indicatorName, is_price_study: false, settings: { length: 14 } });
        return { id: 'study-new', name: indicatorName, inputs: [{ id: 'length', value: 14 }] };
      }
      if (expression.includes('getAllStudies')) {
        const item = state.indicators[0];
        return item ? { id: item.entity_id, name: item.indicator_name, inputs: [{ id: 'length', value: item.settings.length }] } : null;
      }
      if (expression.includes('study.setInputValues')) {
        state.indicators[0].settings.length = 50;
        return { id: entityId, previous: { length: 14 }, inputs: [{ id: 'length', value: 50 }] };
      }
      if (expression.includes('removeEntity')) {
        state.indicators.length = 0;
        return { id: entityId, removed: true };
      }
      throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
    },
  };
  return { deps, inventory };
}

const fence = {
  profile_id: 'profile-a', expected_chart_target_id: 'target-a', expected_chart_id: 'chart-a',
  expected_layout_id: '8', tab_index: 0, pane_index: 0,
};

test('observer indicator read is fenced to exact profile/chart/tab/pane', async () => {
  const { deps } = scopedDeps();
  const result = await readScopedIndicatorSignatures(fence, { _deps: deps });
  assert.equal(result.profile_id, 'profile-a');
  assert.equal(result.chart_target_id, 'target-a');
  assert.equal(result.panes[0].index, 0);
});

test('observer indicator mutation blocks stale pane signature before focus or effect', async () => {
  const { deps } = scopedDeps({ include: false });
  await assert.rejects(
    applyScopedIndicator({ ...fence, indicator_name: 'Relative Strength Index', expected_settings: {}, expected_pane_signature: 'a'.repeat(64) }, { _deps: deps }),
    /pre-mutation pane signature/,
  );
});

test('observer apply requires empty target and returns verified post signature', async () => {
  const { deps } = scopedDeps({ include: false });
  const result = await applyScopedIndicator({
    ...fence, indicator_name: 'Relative Strength Index', expected_settings: '{}', expected_pane_signature: 'b'.repeat(64),
  }, { _deps: deps });
  assert.equal(result.action, 'apply_indicator');
  assert.equal(result.post_mutation_signature, 'a'.repeat(64));
  assert.equal(result.entity_id, 'study-new');
});

test('observer update and remove require exact entity identity and return post signatures', async () => {
  const update = scopedDeps();
  const updated = await updateScopedIndicatorSettings({
    ...fence, indicator_name: 'Relative Strength Index', expected_entity_id: 'study-1',
    expected_pane_signature: 'a'.repeat(64), expected_settings: { length: 50 },
  }, { _deps: update.deps });
  assert.equal(updated.action, 'update_indicator_settings');
  assert.equal(updated.post_mutation_signature, 'a'.repeat(64));

  const remove = scopedDeps();
  const removed = await removeScopedIndicator({
    ...fence, indicator_name: 'Relative Strength Index', expected_entity_id: 'study-1',
    expected_pane_signature: 'a'.repeat(64),
  }, { _deps: remove.deps });
  assert.equal(removed.action, 'remove_indicator');
  assert.equal(removed.post_mutation_indicator_count, 0);
});
