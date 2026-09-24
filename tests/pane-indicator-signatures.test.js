import assert from 'node:assert/strict';
import test from 'node:test';

import {
  derivePaneIndicatorSignature,
  focusedMutationIdentityInventory,
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

test('mutation identity inventory can return one exact pane without changing all-pane default', async () => {
  const allPanes = {
    pane_count: 8,
    panes: Array.from({ length: 8 }, (_, index) => ({
      index,
      indicators: [{
        indicator_id: `study-${index}`,
        entity_id: `entity-${index}`,
        indicator_name: `Study ${index}`,
        is_price_study: false,
        settings: { length: 10 + index },
        get_study_by_id_resolves: true,
        present_in_get_all_studies: true,
        mutation_visible: true,
      }],
    })),
  };
  let expression = '';
  const selected = await mutationIdentityInventory({
    paneIndex: 5,
    _deps: {
      evaluate: async (value) => {
        expression = value;
        return { pane_count: allPanes.pane_count, panes: [allPanes.panes[5]] };
      },
    },
  });

  assert.equal(selected.pane_count, 8);
  assert.deepEqual(selected.panes.map((pane) => pane.index), [5]);
  assert.equal(selected.panes[0].indicators[0].settings.length, 15);
  assert.match(expression, /var requestedPaneIndex = 5/);
  assert.match(expression, /var firstPaneIndex = requestedPaneIndex === null \? 0 : requestedPaneIndex/);
  assert.doesNotMatch(expression, /setLayout|setSymbol|setResolution|removeEntity|insertStudy|\.click\(|navigate/);
});

test('mutation identity inventory binds public studies to expected active pane in same evaluation', async () => {
  let expression = '';
  await assert.rejects(
    mutationIdentityInventory({
      paneIndex: 1,
      expectedActivePaneIndex: 1,
      _deps: {
        evaluate: async (value) => {
          expression = value;
          return { error: 'TradingView pane mutation identity inventory active pane does not match requested pane.' };
        },
      },
    }),
    /active pane does not match requested pane/,
  );
  assert.match(expression, /requestedActivePaneIndex/);
  assert.match(expression, /all\[activeIndex\] === activeChart\._chartWidget/);
});

test('mutation identity inventory rejects an out-of-range pane filter', async () => {
  await assert.rejects(
    mutationIdentityInventory({
      paneIndex: 8,
      _deps: { evaluate: async () => ({ error: 'TradingView pane mutation identity inventory pane index is out of range.' }) },
    }),
    /out of range/,
  );
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

function focusedInventoryFixture({ initialActiveIndex = 0, failInventoryPane, failRestore = false, wrongChartId = false, changeContentAfterFocus = false } = {}) {
  const state = { activeIndex: initialActiveIndex, focusCalls: [], inventoryCalls: [], contentReadCount: 0 };
  const targetUrl = 'https://www.tradingview.com/chart/chart-a/';
  const dependencies = {
    session: { profileId: 'profile-a', chartTargetId: 'target-a', chartTargetUrl: targetUrl },
    async readManagerProfile(profileId) {
      return { id: profileId, status: 'running' };
    },
    async listTabs() {
      return {
        success: true,
        tabs: [{
          index: 2,
          id: 'target-a',
          chart_id: wrongChartId ? 'chart-wrong' : 'chart-a',
          url: wrongChartId ? 'https://www.tradingview.com/chart/chart-wrong/' : targetUrl,
        }],
      };
    },
    async readPanes() {
      return {
        success: true,
        layout: '8',
        chart_count: 8,
        active_index: state.activeIndex,
        panes: Array.from({ length: 8 }, (_, index) => ({
          index,
          symbol: 'OANDA:EURUSD',
          resolution: String(index + 1),
        })),
      };
    },
    async readContent() {
      state.contentReadCount += 1;
      const signature = changeContentAfterFocus && state.contentReadCount > 1 ? 'b'.repeat(64) : 'a'.repeat(64);
      return {
        success: true,
        schema_version: 'pane-indicator-signatures-v1',
        pane_count: 8,
        canonical_pane_index: 0,
        panes: Array.from({ length: 8 }, (_, index) => ({
          index,
          signature,
          indicators: index === 1 ? [{
            indicator_id: 'ESD$TV_VOLUME',
            entity_id: 'volume-pane-1',
            indicator_name: 'Volume',
            is_price_study: false,
            settings: {},
          }] : [],
        })),
      };
    },
    async focusPane({ index }) {
      state.focusCalls.push(index);
      if (failRestore && state.inventoryCalls.length === 1 && index === initialActiveIndex) {
        return { success: true, focused_index: state.activeIndex };
      }
      state.activeIndex = index;
      return { success: true, focused_index: index };
    },
    async readInventory(paneIndex) {
      state.inventoryCalls.push({ paneIndex, activeIndex: state.activeIndex });
      if (state.activeIndex !== paneIndex) throw new Error('pane focus mismatch');
      if (paneIndex === failInventoryPane) throw new Error('inventory read failed');
      const indicators = paneIndex === 1 ? [{
        indicator_id: 'ESD$TV_VOLUME',
        entity_id: 'volume-pane-1',
        indicator_name: 'Volume',
        is_price_study: false,
        settings: {},
        get_study_by_id_resolves: true,
        present_in_get_all_studies: true,
        mutation_visible: true,
      }] : [];
      return {
        success: true,
        schema_version: 'pane-indicator-mutation-inventory-v1',
        pane_count: 8,
        canonical_pane_index: 0,
        panes: [{ index: paneIndex, indicators }],
      };
    },
  };
  return { state, dependencies };
}

const FOCUSED_INVENTORY_INPUT = {
  profile_id: 'profile-a',
  tab_index: 2,
  pane_index: 1,
  expected_chart_target_id: 'target-a',
  expected_chart_id: 'chart-a',
  expected_layout_id: '8',
};

test('focused mutation inventory reads one exact active pane and restores original focus', async () => {
  const { state, dependencies } = focusedInventoryFixture();
  const result = await focusedMutationIdentityInventory(FOCUSED_INVENTORY_INPUT, { _deps: dependencies });

  assert.equal(result.success, true);
  assert.equal(result.schema_version, 'pane-indicator-focused-mutation-inventory-v1');
  assert.equal(result.pane_study_state_mutation_performed, false);
  assert.match(result.pane_study_fingerprint_before_sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.pane_study_fingerprint_before_sha256, result.pane_study_fingerprint_after_sha256);
  assert.deepEqual(result.panes.map((pane) => pane.index), [1]);
  assert.equal(result.panes[0].indicators[0].mutation_visible, true);
  assert.deepEqual(state.inventoryCalls.map(({ paneIndex, activeIndex }) => [paneIndex, activeIndex]),
    [[1, 1]]);
  assert.equal(state.activeIndex, 0);
  assert.deepEqual(result.focus, {
    initial_active_index: 0,
    requested_pane_index: 1,
    focused_pane_indexes: [1],
    restored_active_index: 0,
    pane_restore_confirmed: true,
    browser_tab_switch_performed: false,
    target_tab_index: 2,
    target_id_before: 'target-a',
    target_id_after: 'target-a',
  });
});

test('focused mutation inventory restores original pane after read failure', async () => {
  const { state, dependencies } = focusedInventoryFixture({ failInventoryPane: 3 });
  await assert.rejects(
    focusedMutationIdentityInventory({ ...FOCUSED_INVENTORY_INPUT, pane_index: 3 }, { _deps: dependencies }),
    /inventory read failed/,
  );
  assert.equal(state.activeIndex, 0);
  assert.equal(state.focusCalls.at(-1), 0);
});

test('focused mutation inventory fails closed when pane restoration is unconfirmed', async () => {
  const { state, dependencies } = focusedInventoryFixture({ initialActiveIndex: 2, failRestore: true });
  await assert.rejects(
    focusedMutationIdentityInventory({ ...FOCUSED_INVENTORY_INPUT, pane_index: 7 }, { _deps: dependencies }),
    /restoration is unconfirmed.*could not restore the original active pane/,
  );
  assert.equal(state.activeIndex, 7);
});

test('focused mutation inventory detects pane/study state change across focus/restore', async () => {
  const { state, dependencies } = focusedInventoryFixture({ changeContentAfterFocus: true });
  await assert.rejects(
    focusedMutationIdentityInventory(FOCUSED_INVENTORY_INPUT, { _deps: dependencies }),
    /pane\/study state changed during focus\/read\/restore/,
  );
  assert.equal(state.activeIndex, 0);
});

test('focused mutation inventory rejects wrong chart identity before focusing panes', async () => {
  const { state, dependencies } = focusedInventoryFixture({ wrongChartId: true });
  await assert.rejects(
    focusedMutationIdentityInventory(FOCUSED_INVENTORY_INPUT, { _deps: dependencies }),
    /browser target identity is not unique/,
  );
  assert.deepEqual(state.focusCalls, []);
});

test('mutation identity inventory reads the real getAllStudies surface and performs no mutation', async () => {
  let expression = '';
  await mutationIdentityInventory({
    _deps: {
      evaluate: async (value) => {
        expression = value;
        return {
          pane_count: 1,
          panes: [{
            index: 0,
            indicators: [{
              indicator_id: 'RSI@tv-basicstudies',
              entity_id: 'entity-rsi-0',
              indicator_name: 'Relative Strength Index',
              is_price_study: false,
              settings: { length: 14 },
              get_study_by_id_resolves: true,
              present_in_get_all_studies: true,
              mutation_visible: true,
            }],
          }],
        };
      },
    },
  });
  assert.match(expression, /getAllStudies/);
  assert.doesNotMatch(expression, /setLayout|setSymbol|setResolution|removeEntity|insertStudy|\.click\(|navigate/);
});

test('mutation identity inventory canonicalizes order and rejects duplicate identities', async () => {
  const raw = {
    pane_count: 1,
    panes: [{
      index: 0,
      indicators: [
        {
          indicator_id: 'B', entity_id: 'entity-b', indicator_name: 'B', is_price_study: false,
          settings: {}, get_study_by_id_resolves: true, present_in_get_all_studies: true, mutation_visible: true,
        },
        {
          indicator_id: 'A', entity_id: 'entity-a', indicator_name: 'A', is_price_study: false,
          settings: {}, get_study_by_id_resolves: true, present_in_get_all_studies: true, mutation_visible: true,
        },
      ],
    }],
  };
  const result = await mutationIdentityInventory({ _deps: { evaluate: async () => raw } });
  assert.deepEqual(result.panes[0]?.indicators.map((indicator) => indicator.indicator_id), ['A', 'B']);

  await assert.rejects(
    mutationIdentityInventory({
      _deps: { evaluate: async () => ({
        ...raw,
        panes: [{ ...raw.panes[0], indicators: [raw.panes[0].indicators[0], { ...raw.panes[0].indicators[1], indicator_id: 'B' }] }],
      }) },
    }),
    /duplicate indicator identity/,
  );
  await assert.rejects(
    mutationIdentityInventory({
      _deps: { evaluate: async () => ({
        pane_count: 2,
        panes: [
          {
            ...raw.panes[0],
            indicators: [
              { ...raw.panes[0].indicators[0], indicator_id: 'C', entity_id: 'entity-b' },
              { ...raw.panes[0].indicators[1], indicator_id: 'D', entity_id: 'entity-b' },
            ],
          },
          { index: 1, indicators: [] },
        ],
      }) },
    }),
    /duplicate entity identity/,
  );

  await assert.doesNotReject(
    mutationIdentityInventory({
      _deps: { evaluate: async () => ({
        pane_count: 2,
        panes: [raw.panes[0], { index: 1, indicators: [{ ...raw.panes[0].indicators[0] }] }],
      }) },
    }),
  );
});
