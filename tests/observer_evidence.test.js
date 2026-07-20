import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearObserverSession,
  setObserverSession,
} from '../src/core/observer-session.js';
import {
  captureCandle,
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
