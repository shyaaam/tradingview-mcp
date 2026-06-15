/**
 * Scoped indicator mutation unit tests — no TradingView connection needed.
 *
 * Run: node --test tests/indicator_scoped.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyScopedPlanItem, updateScopedSettings } from '../src/core/indicators.js';

function makeDeps({ studies = [], failSwitch = false, failFocus = false } = {}) {
  const state = {
    studies: studies.map(study => ({
      id: study.id,
      name: study.name,
      inputs: (study.inputs || []).map(input => ({ ...input })),
      values: study.values ? { ...study.values } : undefined,
    })),
    switchedTabs: [],
    focusedPanes: [],
    created: [],
  };

  return {
    state,
    deps: {
      async switchTab({ index }) {
        if (failSwitch) throw new Error('tab target ambiguous');
        state.switchedTabs.push(index);
        return { success: true, action: 'switched', index };
      },
      async focusPane({ index }) {
        if (failFocus) throw new Error('pane target ambiguous');
        state.focusedPanes.push(index);
        return { success: true, focused_index: index, total: 8 };
      },
      async evaluate(expression) {
        if (expression.includes('getAllStudies') && expression.includes('return null')) {
          const match = expression.match(/name === "([^"]+)"/);
          const name = match ? match[1] : '';
          const found = state.studies.find(study => study.name.toLowerCase() === name);
          return found
            ? { id: found.id, name: found.name, inputs: found.inputs, values: found.values }
            : null;
        }
        if (expression.includes('chart.createStudy')) {
          const name = expression.match(/chart.createStudy\("([^"]+)"/)?.[1] || 'Unknown';
          const id = `study-${state.studies.length + 1}`;
          const inputs = [{ id: 'length', value: 14 }];
          state.studies.push({ id, name, inputs });
          state.created.push({ id, name, inputs });
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
    const { deps, state } = makeDeps();

    const result = await applyScopedPlanItem({
      profile_id: 'profile-a',
      tab_index: 0,
      pane_index: 2,
      indicator_name: 'Relative Strength Index',
      expected_settings: { length: 14 },
      action: 'apply_indicator',
      _deps: deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.profile_id, 'profile-a');
    assert.equal(result.tab_index, 0);
    assert.equal(result.pane_index, 2);
    assert.equal(result.indicator_name, 'Relative Strength Index');
    assert.equal(result.action, 'apply_indicator');
    assert.equal(result.applied, true);
    assert.deepEqual(result.previous_settings, {});
    assert.deepEqual(result.new_settings, { length: 14 });
    assert.deepEqual(state.switchedTabs, [0]);
    assert.deepEqual(state.focusedPanes, [2]);
  });

  it('updates indicator settings and returns previous/new scoped evidence', async () => {
    const { deps } = makeDeps({
      studies: [{ id: 'study-rsi', name: 'RSI', inputs: [{ id: 'length', value: 14 }] }],
    });

    const result = await updateScopedSettings({
      profile_id: 'profile-a',
      tab_index: 0,
      pane_index: 0,
      indicator_name: 'RSI',
      expected_settings: { length: 50 },
      _deps: deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'update_indicator_settings');
    assert.equal(result.entity_id, 'study-rsi');
    assert.deepEqual(result.previous_settings, { length: 14 });
    assert.deepEqual(result.new_settings, { length: 50 });
    assert.equal(result.previous_settings_source, 'input_values');
    assert.equal(result.new_settings_source, 'input_values');
    assert.equal(result.profile_id, 'profile-a');
    assert.equal(result.tab_index, 0);
    assert.equal(result.pane_index, 0);
  });

  it('returns displayed values for private studies without raw inputs', async () => {
    const { deps } = makeDeps({
      studies: [{
        id: 'study-private',
        name: 'Private Hermes Study',
        inputs: [],
        values: { Fast: '293.98', Slow: '291.61' },
      }],
    });

    const result = await updateScopedSettings({
      profile_id: 'profile-a',
      tab_index: 0,
      pane_index: 0,
      indicator_name: 'Private Hermes Study',
      expected_settings: { in_1: 25 },
      _deps: deps,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.previous_settings, { values: { Fast: '293.98', Slow: '291.61' } });
    assert.deepEqual(result.new_settings, { values: { Fast: '293.98', Slow: '291.61' } });
    assert.equal(result.previous_settings_source, 'displayed_values');
    assert.equal(result.new_settings_source, 'displayed_values');
    assert.deepEqual(result.settings_unavailable_reason, {});
  });

  it('returns diagnostics when scoped settings evidence is unavailable', async () => {
    const { deps } = makeDeps({
      studies: [{ id: 'study-private', name: 'Private Empty Study', inputs: [] }],
    });

    const result = await updateScopedSettings({
      profile_id: 'profile-a',
      tab_index: 0,
      pane_index: 0,
      indicator_name: 'Private Empty Study',
      expected_settings: { in_1: 25 },
      _deps: deps,
    });

    assert.deepEqual(result.previous_settings, {});
    assert.deepEqual(result.new_settings, {});
    assert.equal(result.previous_settings_source, 'unavailable');
    assert.equal(result.new_settings_source, 'unavailable');
    assert.deepEqual(result.settings_unavailable_reason, {
      previous_settings: 'study did not expose input values or displayed values',
      new_settings: 'study did not expose input values or displayed values',
    });
  });

  it('blocks missing profile scope', async () => {
    await assert.rejects(
      () => applyScopedPlanItem({
        profile_id: '',
        tab_index: 0,
        pane_index: 0,
        indicator_name: 'RSI',
        expected_settings: { length: 14 },
        _deps: makeDeps().deps,
      }),
      /profile_id is required/,
    );
  });

  it('blocks ambiguous tab target selection', async () => {
    await assert.rejects(
      () => applyScopedPlanItem({
        profile_id: 'profile-a',
        tab_index: 0,
        pane_index: 0,
        indicator_name: 'RSI',
        expected_settings: { length: 14 },
        _deps: makeDeps({ failSwitch: true }).deps,
      }),
      /tab target ambiguous/,
    );
  });

  it('blocks ambiguous pane target selection', async () => {
    await assert.rejects(
      () => applyScopedPlanItem({
        profile_id: 'profile-a',
        tab_index: 0,
        pane_index: 0,
        indicator_name: 'RSI',
        expected_settings: { length: 14 },
        _deps: makeDeps({ failFocus: true }).deps,
      }),
      /pane target ambiguous/,
    );
  });

  it('blocks unsupported action', async () => {
    await assert.rejects(
      () => applyScopedPlanItem({
        profile_id: 'profile-a',
        tab_index: 0,
        pane_index: 0,
        indicator_name: 'RSI',
        expected_settings: { length: 14 },
        action: 'delete_indicator',
        _deps: makeDeps().deps,
      }),
      /unsupported scoped indicator action/,
    );
  });

  it('blocks update when target indicator is missing', async () => {
    await assert.rejects(
      () => updateScopedSettings({
        profile_id: 'profile-a',
        tab_index: 0,
        pane_index: 0,
        indicator_name: 'RSI',
        expected_settings: { length: 14 },
        _deps: makeDeps().deps,
      }),
      /indicator not found for update/,
    );
  });
});
