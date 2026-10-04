import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearObserverSession,
  setObserverSession,
} from '../src/core/observer-session.js';
import {
  captureCandle,
  capturePaneTelemetryOhlcv,
  captureTelemetryOhlcv,
  identity,
} from '../src/core/observer-evidence.js';
import { registerObserverTool } from '../src/release/observer-schema.js';

const session = {
  managerBaseUrl: 'http://127.0.0.1:9000/api',
  profileId: 'profile-exact',
  cdpUrl: 'http://127.0.0.1:9000/api/profiles/profile-exact/cdp',
  chartTargetId: 'target-exact',
  chartTargetUrl: 'https://www.tradingview.com/chart/chart-exact/',
};

test.afterEach(() => clearObserverSession());

test('observer evidence fails closed before preparation', async () => {
  await assert.rejects(
    identity({ _deps: { evaluateBound: async () => ({}) } }),
    /Observer session is not prepared/,
  );
  await assert.rejects(
    captureCandle({
      symbol: 'NASDAQ:AAPL', timeframe: '60', source_candle_time: '2026-07-17T10:00:00Z',
      _deps: { evaluateBound: async () => ({}) },
    }),
    /Observer session is not prepared/,
  );
});

test('identity uses exact prepared binding and never returns raw account subject', async () => {
  setObserverSession(session);
  let expression;
  const result = await identity({
    _deps: {
      evaluateBound: async (value, options) => {
        expression = value;
        assert.deepEqual(options, { awaitPromise: true });
        return {
          chart_id: 'chart-exact',
          layout_id: 'layout-exact',
          account_subject_sha256: 'a'.repeat(64),
        };
      },
    },
  });

  assert.deepEqual(result, {
    success: true,
    profile_id: 'profile-exact',
    chart_target_id: 'target-exact',
    chart_id: 'chart-exact',
    layout_id: 'layout-exact',
    account_subject_sha256: 'a'.repeat(64),
  });
  assert.doesNotMatch(expression, /raw-account-subject|accountSubjectValue/);
  assert.match(expression, /metaInfo\.username/);
  assert.match(expression, /collection\.layout/);
});

test('identity refuses ambiguous authenticated identity without exposing its value', async () => {
  setObserverSession(session);
  await assert.rejects(
    identity({
      _deps: {
        evaluateBound: async () => ({ error: 'Bound authenticated chart identity is missing or ambiguous.' }),
      },
    }),
    /missing or ambiguous/,
  );
});

test('candle capture returns one finite bounded projection with operation timestamp', async () => {
  setObserverSession(session);
  let expression;
  const result = await captureCandle({
    symbol: 'NASDAQ:AAPL',
    timeframe: '60',
    source_candle_time: '2026-07-17T10:00:00Z',
    _deps: {
      evaluateBound: async (value) => {
        expression = value;
        return { open: 100, high: 110, low: 95, close: 105, volume: 1234 };
      },
      now: () => new Date('2026-07-17T10:00:01Z'),
    },
  });

  assert.deepEqual(result, {
    success: true,
    symbol: 'NASDAQ:AAPL',
    timeframe: '60',
    source_candle_time: '2026-07-17T10:00:00Z',
    captured_at: '2026-07-17T10:00:01.000Z',
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 1234,
    adapter_version: 'tradingview-mcp-observer-v1',
  });
  assert.match(expression, /mainSeries\(\)/);
  assert.match(expression, /bars\(\)/);
  assert.doesNotMatch(expression, /setSymbol|setResolution|capture_screenshot|webSocketDebuggerUrl/);
});

test('candle capture refuses missing, duplicate, and non-finite readback', async () => {
  setObserverSession(session);
  const input = {
    symbol: 'NASDAQ:AAPL', timeframe: '60', source_candle_time: '2026-07-17T10:00:00Z',
  };
  for (const [, value] of [
    ['missing', { error: 'Requested candle is missing from the bound chart.' }],
    ['duplicate', { error: 'Requested candle timestamp is duplicated or ambiguous.' }],
    ['non-finite', { open: Number.NaN, high: 1, low: 1, close: 1, volume: 1 }],
  ]) {
    await assert.rejects(
      captureCandle({ ...input, _deps: { evaluateBound: async () => value } }),
      /Requested candle|non-finite/,
    );
  }
});

test('bounded telemetry OHLCV extraction preserves exact binding and raw strings', async () => {
  setObserverSession(session);
  let expression;
  const result = await captureTelemetryOhlcv({
    symbol: 'NASDAQ:AAPL',
    timeframe: '60',
    count: 2,
    _deps: {
      evaluateBound: async (value) => {
        expression = value;
        return {
          symbol: 'NASDAQ:AAPL',
          timeframe: '60',
          candles: [
            { opened_at: '2026-07-17T08:00:00.000Z', open: '100.00', high: '110', low: '95', close: '105.25', volume: '1234' },
            { opened_at: '2026-07-17T09:00:00.000Z', open: '105.25', high: '112', low: '101', close: '111', volume: null },
          ],
          studies: [{ study_id: 'rsi', study_name: 'RSI', values: [{ source_label: 'data-window', field_label: 'RSI', raw_value: '52.3400' }] }],
        };
      },
      now: () => new Date('2026-07-17T10:00:01Z'),
    },
  });
  assert.equal(result.extraction_version, 'observer-telemetry-ohlcv-v1');
  assert.equal(result.requested_count, 2);
  assert.equal(result.candles[0].open, '100.00');
  assert.equal(result.studies[0].values[0].raw_value, '52.3400');
  assert.match(expression, /actualSymbol/);
  assert.match(expression, /actualTimeframe/);
  assert.match(expression, /end - 2 \+ 1/);
  assert.doesNotMatch(expression, /setSymbol|setResolution|capture_screenshot/);
});

test('bounded telemetry OHLCV extraction fails closed on invalid count and binding errors', async () => {
  setObserverSession(session);
  await assert.rejects(() => captureTelemetryOhlcv({ symbol: 'AAPL', timeframe: '60', count: 501 }), /between 1 and 500/);
  await assert.rejects(() => captureTelemetryOhlcv({ symbol: 'AAPL', timeframe: '60', count: 2, _deps: { evaluateBound: async () => ({ error: 'Bound chart symbol or timeframe does not match the requested extraction.' }) } }), /does not match/);
});

test('exact pane telemetry binds pane directly without active-widget, focus, or mutation paths', async () => {
  setObserverSession(session);
  const expressions = [];
  const result = await capturePaneTelemetryOhlcv({
    profile_id: 'profile-exact',
    expected_chart_target_id: 'target-exact',
    expected_chart_id: 'chart-exact',
    expected_layout_id: '8',
    tab_index: 0,
    pane_index: 3,
    symbol: 'BITSTAMP:BTCUSDT',
    timeframe: '60',
    count: 2,
    _deps: {
      listTabs: async () => ({
        success: true,
        tab_count: 1,
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
          candles: [{ opened_at: '2026-07-17T10:00:00.000Z', open: '100', high: '110', low: '95', close: '105', volume: '1234' }],
          studies: [{ study_id: 'rsi', study_name: 'RSI', values: [{ source_label: 'data-window', field_label: 'RSI', raw_value: '52.3' }] }],
        };
      },
      now: () => new Date('2026-07-17T10:00:01Z'),
    },
  });

  assert.deepEqual(result, {
    success: true,
    extraction_version: 'observer-pane-telemetry-ohlcv-v1',
    profile_id: 'profile-exact',
    chart_target_id: 'target-exact',
    chart_id: 'chart-exact',
    layout_id: '8',
    tab_index: 0,
    pane_index: 3,
    pane_count: 8,
    symbol: 'BITSTAMP:BTCUSDT',
    timeframe: '60',
    requested_count: 2,
    captured_at: '2026-07-17T10:00:01.000Z',
    candles: [{ opened_at: '2026-07-17T10:00:00.000Z', open: '100', high: '110', low: '95', close: '105', volume: '1234' }],
    study_telemetry_state: 'available',
    study_telemetry_reason: null,
    studies: [{ study_id: 'rsi', study_name: 'RSI', values: [{ source_label: 'data-window', field_label: 'RSI', raw_value: '52.3' }] }],
  });
  assert.match(expressions[1], /cwc\.getAll\(\)/);
  assert.match(expressions[1], /all\[paneIndex\]/);
  assert.doesNotMatch(expressions[1], /_activeChartWidgetWV|pane_focus|setSymbol|setResolution|createStudy|removeEntity|navigate/);
});

test('exact pane telemetry reports bounded ambiguity category and indexes while failing closed', async () => {
  setObserverSession(session);
  const input = {
    profile_id: 'profile-exact',
    expected_chart_target_id: 'target-exact',
    expected_chart_id: 'chart-exact',
    expected_layout_id: '8',
    tab_index: 0,
    pane_index: 0,
    symbol: 'BITSTAMP:BTCUSDT',
    timeframe: '60',
    count: 1,
  };
  const studies = Array.from({ length: 8 }, (_, index) => ({
    study_id: `study-${index}`,
    study_name: `Study ${index}`,
    values: [],
  }));
  const invalidValues = [
    { source_label: '', field_label: 'Projection', raw_value: '1' },
    { source_label: 'data-window', field_label: '  ', raw_value: '1' },
  ];
  const cases = [
    { studyIndex: 7, values: [invalidValues[0]], valueIndex: 0, reason: 'EMPTY_SOURCE_LABEL' },
    { studyIndex: 7, values: [invalidValues[1]], valueIndex: 0, reason: 'EMPTY_FIELD_LABEL' },
    { studyIndex: 7, values: [
      { source_label: 'data-window', field_label: 'Projection', raw_value: '1' },
      { source_label: 'data-window', field_label: 'Projection', raw_value: '2' },
    ], valueIndex: 1, reason: 'DUPLICATE_SOURCE_FIELD' },
  ];

  for (const testCase of cases) {
    studies[testCase.studyIndex].values = testCase.values;
    await assert.rejects(() => capturePaneTelemetryOhlcv({ ...input, _deps: {
      listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-exact', chart_id: 'chart-exact', url: session.chartTargetUrl }] }),
      evaluateBound: async (expression) => expression.includes('layout_id')
        ? { layout_id: '8' }
        : {
          pane_index: 0,
          pane_count: 1,
          symbol: input.symbol,
          timeframe: input.timeframe,
          candles: [{ opened_at: '2026-07-17T10:00:00.000Z', open: '100', high: '110', low: '95', close: '105', volume: '1234' }],
          studies,
        },
    } }), new RegExp(`studies\\[${testCase.studyIndex}\\]\\.values\\[${testCase.valueIndex}\\] is ambiguous: ${testCase.reason}`));
  }
});

test('exact pane telemetry omits only labeled empty values and still rejects duplicate identity', async () => {
  setObserverSession(session);
  const input = {
    profile_id: 'profile-exact',
    expected_chart_target_id: 'target-exact',
    expected_chart_id: 'chart-exact',
    expected_layout_id: '8',
    tab_index: 0,
    pane_index: 0,
    symbol: 'BITSTAMP:BTCUSDT',
    timeframe: '60',
    count: 1,
  };
  const studies = [{
    study_id: 'pvp',
    study_name: 'PvP',
    values: [
      { source_label: 'data-window', field_label: 'Optional rail', raw_value: '' },
      { source_label: 'data-window', field_label: 'Current POC', raw_value: '100' },
    ],
  }];
  const result = await capturePaneTelemetryOhlcv({ ...input, _deps: {
    listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-exact', chart_id: 'chart-exact', url: session.chartTargetUrl }] }),
    evaluateBound: async (expression) => expression.includes('layout_id')
      ? { layout_id: '8' }
      : {
        pane_index: 0,
        pane_count: 1,
        symbol: input.symbol,
        timeframe: input.timeframe,
        candles: [{ opened_at: '2026-07-17T10:00:00.000Z', open: '100', high: '110', low: '95', close: '105', volume: '1234' }],
        studies,
      },
    now: () => new Date('2026-07-17T10:00:01.000Z'),
  } });
  assert.deepEqual(result.studies, [{
    study_id: 'pvp',
    study_name: 'PvP',
    values: [{ source_label: 'data-window', field_label: 'Current POC', raw_value: '100' }],
  }]);

  studies[0].values = [
    { source_label: 'data-window', field_label: 'Optional rail', raw_value: '' },
    { source_label: 'data-window', field_label: 'Optional rail', raw_value: '101' },
  ];
  await assert.rejects(() => capturePaneTelemetryOhlcv({ ...input, _deps: {
    listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-exact', chart_id: 'chart-exact', url: session.chartTargetUrl }] }),
    evaluateBound: async (expression) => expression.includes('layout_id')
      ? { layout_id: '8' }
      : {
        pane_index: 0,
        pane_count: 1,
        symbol: input.symbol,
        timeframe: input.timeframe,
        candles: [{ opened_at: '2026-07-17T10:00:00.000Z', open: '100', high: '110', low: '95', close: '105', volume: '1234' }],
        studies,
      },
  } }), /studies\[0\]\.values\[1\] is ambiguous: DUPLICATE_SOURCE_FIELD/);
});

test('exact pane telemetry fails closed on identity, layout, and pane readback drift', async () => {
  setObserverSession(session);
  const input = {
    profile_id: 'profile-exact',
    expected_chart_target_id: 'target-exact',
    expected_chart_id: 'chart-exact',
    expected_layout_id: '8',
    tab_index: 0,
    pane_index: 3,
    symbol: 'BITSTAMP:BTCUSDT',
    timeframe: '60',
    count: 1,
  };
  await assert.rejects(
    capturePaneTelemetryOhlcv({ ...input, expected_chart_id: 'wrong-chart', _deps: { listTabs: async () => ({ success: true, tabs: [] }) } }),
    /exact profile\/chart authority/,
  );
  await assert.rejects(
    capturePaneTelemetryOhlcv({ ...input, _deps: {
      listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-exact', chart_id: 'chart-exact', url: session.chartTargetUrl }] }),
      evaluateBound: async (expression) => expression.includes('layout_id') ? { layout_id: '4' } : {},
    } }),
    /layout does not match authority/,
  );
  await assert.rejects(
    capturePaneTelemetryOhlcv({ ...input, _deps: {
      listTabs: async () => ({ success: true, tabs: [{ index: 0, id: 'target-exact', chart_id: 'chart-exact', url: session.chartTargetUrl }] }),
      evaluateBound: async (expression) => expression.includes('layout_id') ? { layout_id: '8' } : { error: 'Exact requested pane is missing or ambiguous.' },
    } }),
    /missing or ambiguous/,
  );
});

test('identity registration rejects unexpected arguments', async () => {
  const registered = [];
  registerObserverTool({
    registerTool(name, config, handler) {
      registered.push({ name, config, handler });
    },
  }, 'tv_observer_identity', 'identity', async () => ({ success: true }));

  assert.equal(registered.length, 1);
  await assert.rejects(
    registered[0].handler({ unexpected: 'value' }),
    /accepts no input arguments/,
  );
});

test('pane mutation inventory registration accepts its declared pane_index argument', async () => {
  setObserverSession(session);
  const handlers = new Map();
  registerObserverTool({
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    },
  }, 'pane_indicator_mutation_inventory', 'pane inventory', async ({ pane_index }) => ({ pane_index }));

  assert.deepEqual(await handlers.get('pane_indicator_mutation_inventory')({ pane_index: 3 }), { pane_index: 3 });
});
