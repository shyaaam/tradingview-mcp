import assert from 'node:assert/strict';
import test from 'node:test';

import { probeLayoutCapability } from '../src/core/pane.js';

function state(layout, count, active = 0) {
  return {
    success: true,
    layout,
    layout_name: String(layout),
    chart_count: count,
    active_index: active,
    panes: Array.from({ length: count }, (_, index) => ({ index, symbol: `SYM${index}`, resolution: '5' })),
  };
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (ms) => { value += ms; },
  };
}

test('proves exact pane count, validates focus, and restores prior layout', async () => {
  const clock = fakeClock();
  let current = state('s', 1, 0);
  const mutations = [];
  const result = await probeLayoutCapability({ paneCount: 4, timeoutMs: 1000, pollIntervalMs: 10, stablePolls: 2, validateFocus: true }, {
    now: clock.now,
    sleep: clock.sleep,
    list: async () => current,
    setLayout: async ({ layout }) => {
      mutations.push(layout);
      current = layout === '4' ? state('4', 4, 0) : state('s', 1, 0);
    },
    focus: async ({ index }) => { current = state(current.layout, current.chart_count, index); },
  });

  assert.equal(result.supported, true);
  assert.equal(result.stable, true);
  assert.equal(result.focus_validated, true);
  assert.equal(result.restoration_succeeded, true);
  assert.deepEqual(mutations, ['4', 's']);
  assert.equal(result.before.chart_count, 1);
  assert.equal(result.observed.chart_count, 4);
  assert.equal(result.restored.chart_count, 1);
});

test('returns supported false when requested pane count is not observed', async () => {
  const clock = fakeClock();
  let current = state('s', 1, 0);
  const result = await probeLayoutCapability({ paneCount: 8, timeoutMs: 30, pollIntervalMs: 10, stablePolls: 2 }, {
    now: clock.now,
    sleep: clock.sleep,
    list: async () => current,
    setLayout: async ({ layout }) => { current = layout === 's' ? state('s', 1, 0) : state('4', 4, 0); },
    focus: async () => undefined,
  });
  assert.equal(result.supported, false);
  assert.equal(result.failure_reason, 'requested_layout_not_observed');
  assert.equal(result.restoration_succeeded, true);
});

test('fails closed on focus mismatch', async () => {
  const clock = fakeClock();
  let current = state('s', 1, 0);
  const result = await probeLayoutCapability({ paneCount: 2, timeoutMs: 100, pollIntervalMs: 10, stablePolls: 1 }, {
    now: clock.now,
    sleep: clock.sleep,
    list: async () => current,
    setLayout: async ({ layout }) => { current = layout === '2h' ? state('2h', 2, 0) : state('s', 1, 0); },
    focus: async () => undefined,
  });
  assert.equal(result.supported, false);
  assert.equal(result.failure_reason, 'pane_focus_validation_failed');
  assert.equal(result.restoration_succeeded, true);
});

test('restoration failure overrides a successful probe', async () => {
  const clock = fakeClock();
  let current = state('s', 1, 0);
  let mutationCount = 0;
  const result = await probeLayoutCapability({ paneCount: 4, timeoutMs: 30, pollIntervalMs: 10, stablePolls: 1, validateFocus: false }, {
    now: clock.now,
    sleep: clock.sleep,
    list: async () => current,
    setLayout: async ({ layout }) => {
      mutationCount += 1;
      if (mutationCount === 1 && layout === '4') current = state('4', 4, 0);
    },
    focus: async () => undefined,
  });
  assert.equal(result.supported, false);
  assert.equal(result.failure_reason, 'layout_restoration_failed');
  assert.equal(result.restoration_succeeded, false);
});
