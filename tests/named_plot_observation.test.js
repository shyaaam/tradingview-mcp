import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureNamedPlotTelemetry,
} from '../src/core/observer-named-plot.js';
import {
  clearObserverSession,
  setObserverSession,
} from '../src/core/observer-session.js';

const session = {
  managerBaseUrl: 'http://127.0.0.1:9000/api',
  profileId: 'profile-exact',
  cdpUrl: 'http://127.0.0.1:9000/api/profiles/profile-exact/cdp',
  chartTargetId: 'target-exact',
  chartTargetUrl: 'https://www.tradingview.com/chart/chart-exact/',
};

const input = {
  profile_id: 'profile-exact',
  expected_chart_target_id: 'target-exact',
  expected_chart_id: 'chart-exact',
  expected_layout_id: '8',
  tab_index: 0,
  pane_index: 3,
  symbol: 'BITSTAMP:BTCUSDT',
  timeframe: '60',
  study_id: 'PUB;study-id',
  study_name: 'Telemetry Companion',
  plot_names: ['TVOBS_HTF_V1_PVP_RAIL', 'TVOBS_LTF_V1_DIVERGENCE'],
};

test.afterEach(() => clearObserverSession());

test('named plot capture returns only requested plots from exact pane/study', async () => {
  setObserverSession(session);
  const expressions = [];
  const result = await captureNamedPlotTelemetry({
    ...input,
    _deps: {
      listTabs: async () => ({
        success: true,
        tabs: [{ index: 0, id: 'target-exact', chart_id: 'chart-exact', url: session.chartTargetUrl }],
      }),
      evaluateBound: async (expression) => {
        expressions.push(expression);
        if (expression.includes('layout_id')) return { layout_id: '8' };
        return {
          pane_index: 3,
          pane_count: 8,
          symbol: 'BITSTAMP:BTCUSDT',
          timeframe: '60',
          study_id: input.study_id,
          study_name: input.study_name,
          plots: [
            { plot_name: 'TVOBS_HTF_V1_PVP_RAIL', raw_value: '24123.50', value_state: 'present' },
            { plot_name: 'TVOBS_LTF_V1_DIVERGENCE', raw_value: 'bullish', value_state: 'present' },
          ],
        };
      },
      now: () => new Date('2026-08-15T12:00:01Z'),
    },
  });

  assert.deepEqual(result, {
    success: true,
    extraction_version: 'observer-named-plot-telemetry-v1',
    profile_id: 'profile-exact',
    chart_target_id: 'target-exact',
    chart_id: 'chart-exact',
    layout_id: '8',
    tab_index: 0,
    pane_index: 3,
    pane_count: 8,
    symbol: 'BITSTAMP:BTCUSDT',
    timeframe: '60',
    study_id: input.study_id,
    study_name: input.study_name,
    plots: [
      { plot_name: 'TVOBS_HTF_V1_PVP_RAIL', raw_value: '24123.50', value_state: 'present' },
      { plot_name: 'TVOBS_LTF_V1_DIVERGENCE', raw_value: 'bullish', value_state: 'present' },
    ],
    captured_at: '2026-08-15T12:00:01.000Z',
  });
  assert.equal(expressions.length, 2);
  assert.match(expressions[1], /dataSources\(\)/);
  assert.match(expressions[1], /paneIndex = 3/);
  assert.doesNotMatch(expressions[1], /activeChartWidgetWV|focusPane|setSymbol|setResolution|pane_focus/);
});

test('named plot capture treats explicit empty marker as valid no-event evidence', async () => {
  setObserverSession(session);
  const result = await captureNamedPlotTelemetry({
    ...input,
    _deps: {
      listTabs: async () => ({
        success: true,
        tabs: [{ index: 0, id: 'target-exact', chart_id: 'chart-exact', url: session.chartTargetUrl }],
      }),
      evaluateBound: async (expression) => expression.includes('layout_id')
        ? { layout_id: '8' }
        : {
          pane_index: 3,
          pane_count: 8,
          symbol: 'BITSTAMP:BTCUSDT',
          timeframe: '60',
          study_id: input.study_id,
          study_name: input.study_name,
          plots: input.plot_names.map((plot_name) => ({ plot_name, raw_value: null, value_state: 'not-present' })),
        },
      now: () => new Date('2026-08-15T12:00:01Z'),
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.plots.every((plot) => plot.raw_value === null && plot.value_state === 'not-present'), true);
});

test('named plot capture rejects invalid plot names and duplicate requested names', async () => {
  setObserverSession(session);
  await assert.rejects(
    () => captureNamedPlotTelemetry({ ...input, plot_names: ['RSI'] }),
    /TVOBS_\*_V1_\* names/,
  );
  await assert.rejects(
    () => captureNamedPlotTelemetry({ ...input, plot_names: ['TVOBS_X_V1_Y', 'TVOBS_X_V1_Y'] }),
    /plot_names must be unique/,
  );
});

test('named plot capture fails closed on missing, duplicate, or stale readback', async () => {
  setObserverSession(session);
  const baseDeps = {
    listTabs: async () => ({
      success: true,
      tabs: [{ index: 0, id: 'target-exact', chart_id: 'chart-exact', url: session.chartTargetUrl }],
    }),
    now: () => new Date('2026-08-15T12:00:01Z'),
  };
  for (const result of [
    { error: 'Requested study plot is missing or ambiguous.' },
    { pane_index: 3, pane_count: 8, symbol: 'BITSTAMP:BTCUSDT', timeframe: '60', study_id: input.study_id, study_name: input.study_name, plots: [{ plot_name: input.plot_names[0], raw_value: '1', value_state: 'present' }] },
    { pane_index: 3, pane_count: 8, symbol: 'BITSTAMP:ETHUSDT', timeframe: '60', study_id: input.study_id, study_name: input.study_name, plots: [{ plot_name: input.plot_names[0], raw_value: '1', value_state: 'present' }, { plot_name: input.plot_names[1], raw_value: '2', value_state: 'present' }] },
  ]) {
    await assert.rejects(
      () => captureNamedPlotTelemetry({ ...input, _deps: { ...baseDeps, evaluateBound: async (expression) => expression.includes('layout_id') ? { layout_id: '8' } : result } }),
      /missing or ambiguous|incomplete or ambiguous|readback does not match/,
    );
  }
});
