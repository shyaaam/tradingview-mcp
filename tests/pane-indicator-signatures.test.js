import assert from 'node:assert/strict';
import test from 'node:test';

import {
  derivePaneIndicatorSignature,
  indicatorSignatures,
  mutationIdentityInventory,
} from '../src/core/pane.js';

function rawInventory({ changed = false } = {}) {
  return {
    pane_count: 2,
    panes: [0, 1].map((index) => ({
      index,
      indicators: [{
        indicator_id: 'RSI@tv-basicstudies',
        entity_id: `study-${index}`,
        indicator_name: 'Relative Strength Index',
        is_price_study: false,
        settings: {
          length: changed && index === 1 ? 21 : 14,
          first_visible_bar_time: index + 1,
          last_visible_bar_time: index + 2,
          subscribeRealtime: index % 2 === 0,
        },
      }],
    })),
  };
}

test('indicator signatures read every pane without mutation and exclude volatile/entity fields', async () => {
  let expression = '';
  const result = await indicatorSignatures({
    _deps: { evaluate: async (value) => { expression = value; return rawInventory(); } },
  });
  assert.equal(result.schema_version, 'pane-indicator-signatures-v1');
  assert.deepEqual(result.panes.map((pane) => pane.index), [0, 1]);
  assert.equal(result.panes[0].signature, result.panes[1].signature);
  assert.doesNotMatch(expression, /setLayout|setSymbol|setResolution|removeEntity|insertStudy|\.click\(|focus/);
  assert.equal(result.panes[0].indicators[0].settings.first_visible_bar_time, 1);
  assert.equal(derivePaneIndicatorSignature(result.panes[0].indicators), result.panes[0].signature);
  const changed = await indicatorSignatures({ _deps: { evaluate: async () => rawInventory({ changed: true }) } });
  assert.notEqual(result.panes[0].signature, changed.panes[1].signature);
});
test('indicator signatures fail closed on malformed or duplicate evidence', async () => {
  await assert.rejects(
    indicatorSignatures({ _deps: { evaluate: async () => ({ pane_count: 2, panes: [] }) } }),
    /incompatible/,
  );
  await assert.rejects(
    indicatorSignatures({ _deps: { evaluate: async () => ({
      pane_count: 1,
      panes: [{ index: 0, indicators: [rawInventory().panes[0].indicators[0], rawInventory().panes[0].indicators[0]] }],
    }) } }),
    /duplicate/,
  );
});

test('mutation inventory carries entity addressability and read-only expression trace', async () => {
  let expression = '';
  const result = await mutationIdentityInventory({
    _deps: {
      evaluate: async (value) => {
        expression = value;
        return {
          pane_count: 1,
          panes: [{
            index: 0,
            indicators: [{
              ...rawInventory().panes[0].indicators[0],
              get_study_by_id_resolves: true,
              present_in_get_all_studies: true,
              mutation_visible: true,
            }],
          }],
        };
      },
    },
  });
  assert.equal(result.schema_version, 'pane-indicator-mutation-inventory-v1');
  assert.equal(result.panes[0].indicators[0].mutation_visible, true);
  assert.match(expression, /getAllStudies/);
  assert.doesNotMatch(expression, /setLayout|setSymbol|setResolution|removeEntity|insertStudy|\.click\(|navigate/);
});
