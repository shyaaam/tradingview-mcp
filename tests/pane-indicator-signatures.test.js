import assert from 'node:assert/strict';
import test from 'node:test';

import {
  derivePaneIndicatorSignature,
  indicatorSignatures,
  mutationIdentityInventory,
} from '../src/core/pane.js';

function inventory({ changedPane = null } = {}) {
  return {
    pane_count: 8,
    panes: Array.from({ length: 8 }, (_, index) => ({
      index,
      indicators: [{
        indicator_id: 'RSI@tv-basicstudies',
        entity_id: `study-rsi-${index}`,
        indicator_name: 'Relative Strength Index',
        is_price_study: false,
        settings: {
          length: changedPane === index ? 21 : 14,
          first_visible_bar_time: index + 1,
          last_visible_bar_time: index + 2,
          subscribeRealtime: index % 2 === 0,
        },
      }],
    })),
  };
}

test('pane indicator signatures are read-only and pane zero is canonical input', async () => {
  let expression = '';
  const result = await indicatorSignatures({
    _deps: {
      evaluate: async (value) => {
        expression = value;
        return inventory();
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.schema_version, 'pane-indicator-signatures-v1');
  assert.equal(result.pane_count, 8);
  assert.equal(result.canonical_pane_index, 0);
  assert.deepEqual(result.panes.map((pane) => pane.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(result.panes.map((pane) => pane.signature)).size, 1);
  assert.doesNotMatch(expression, /setLayout|setSymbol|setResolution|\.click\(|pane_focus/);
});

test('stable indicator settings change signature while volatile viewport inputs do not', async () => {
  const baseline = await indicatorSignatures({ _deps: { evaluate: async () => inventory() } });
  const changed = await indicatorSignatures({ _deps: { evaluate: async () => inventory({ changedPane: 3 }) } });
  assert.notEqual(baseline.panes[0].signature, changed.panes[3].signature);
  assert.equal(baseline.panes[0].signature, derivePaneIndicatorSignature(baseline.panes[0].indicators));
  assert.equal(baseline.panes[0].signature, baseline.panes[7].signature);
});

test('live entity identity is excluded from stable parity signatures', async () => {
  const baseline = await indicatorSignatures({ _deps: { evaluate: async () => inventory() } });
  const rotated = await indicatorSignatures({ _deps: { evaluate: async () => ({
    ...inventory(),
    panes: inventory().panes.map((pane) => ({
      ...pane,
      indicators: pane.indicators.map((indicator) => ({ ...indicator, entity_id: `new-${indicator.entity_id}` })),
    })),
  }) } });
  assert.deepEqual(rotated.panes.map((pane) => pane.signature), baseline.panes.map((pane) => pane.signature));
});

test('pane indicator signatures fail closed for incomplete pane evidence', async () => {
  await assert.rejects(
    indicatorSignatures({ _deps: { evaluate: async () => ({ pane_count: 8, panes: [] }) } }),
    /incompatible/,
  );
});

test('mutation identity inventory exposes stable, live, and mutation-visible identities', async () => {
  const result = await mutationIdentityInventory({
    _deps: {
      evaluate: async () => ({
        pane_count: 2,
        panes: [
          {
            index: 0,
            indicators: [
              {
                indicator_id: 'RSI@tv-basicstudies',
                entity_id: 'entity-rsi-0',
                indicator_name: 'Relative Strength Index',
                is_price_study: false,
                settings: { length: 14 },
                get_study_by_id_resolves: true,
                present_in_get_all_studies: true,
                mutation_visible: true,
              },
              {
                indicator_id: 'ESD$TV_VOLUME',
                entity_id: 'entity-volume-0',
                indicator_name: 'Volume',
                is_price_study: false,
                settings: {},
                get_study_by_id_resolves: true,
                present_in_get_all_studies: false,
                mutation_visible: false,
              },
            ],
          },
          {
            index: 1,
            indicators: [],
          },
        ],
      }),
    },
  });
  assert.equal(result.schema_version, 'pane-indicator-mutation-inventory-v1');
  assert.equal(result.panes[0].indicators[0].mutation_visible, true);
  assert.equal(result.panes[0].indicators[1].present_in_get_all_studies, false);
  assert.equal(result.panes[0].indicators[1].mutation_visible, false);
});

test('mutation identity inventory rejects contradictory visibility evidence', async () => {
  await assert.rejects(
    mutationIdentityInventory({
      _deps: {
        evaluate: async () => ({
          pane_count: 1,
          panes: [{
            index: 0,
            indicators: [{
              indicator_id: 'RSI@tv-basicstudies',
              entity_id: 'entity-rsi-0',
              indicator_name: 'Relative Strength Index',
              is_price_study: false,
              settings: {},
              get_study_by_id_resolves: true,
              present_in_get_all_studies: false,
              mutation_visible: true,
            }],
          }],
        }),
      },
    }),
    /incompatible/,
  );
});
