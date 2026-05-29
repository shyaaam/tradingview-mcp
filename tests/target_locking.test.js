/**
 * Unit/static tests for Chrome CDP target-locking support.
 * These tests do not require a live TradingView/CDP session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCdpConfig } from '../src/connection.js';
import { targetReadinessCheck } from '../src/core/target.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

describe('CDP config', () => {
  it('defaults to localhost:9222', () => {
    withEnv({ CDP_HOST: undefined, CDP_PORT: undefined }, () => {
      assert.deepEqual(getCdpConfig(), { host: 'localhost', port: 9222 });
    });
  });

  it('uses CDP_HOST and CDP_PORT from environment', () => {
    withEnv({ CDP_HOST: '127.0.0.1', CDP_PORT: '9333' }, () => {
      assert.deepEqual(getCdpConfig(), { host: '127.0.0.1', port: 9333 });
    });
  });

  it('rejects invalid CDP_PORT values', () => {
    withEnv({ CDP_PORT: 'not-a-port' }, () => {
      assert.throws(() => getCdpConfig(), /CDP_PORT must be a valid TCP port/);
    });
  });
});

describe('target_id read-tool wiring', () => {
  it('connection layer maintains target-scoped clients', () => {
    const source = read('src/connection.js');
    assert.match(source, /clientsByTargetId = new Map\(\)/);
    assert.match(source, /target_id/);
    assert.match(source, /targetId/);
    assert.match(source, /setDefaultTargetId/);
    assert.match(source, /activateTarget/);
  });

  it('tab core uses shared CDP config helpers instead of hardcoded host and port', () => {
    const source = read('src/core/tab.js');
    assert.match(source, /listCdpTargets/);
    assert.match(source, /activateTarget/);
    assert.doesNotMatch(source, /const CDP_HOST = 'localhost'/);
    assert.doesNotMatch(source, /const CDP_PORT = 9222/);
  });

  it('new readiness diagnostic tool exposes the expected schema fields', () => {
    const source = read('src/tools/target.js');
    assert.match(source, /tab_target_readiness_check/);
    assert.match(source, /target_id/);
    assert.match(source, /expected_symbol/);
    assert.match(source, /expected_timeframe/);
    assert.match(source, /max_wait_ms/);
    assert.match(source, /poll_interval_ms/);
  });

  it('readiness helper uses target_id-aware evaluate and returns readiness shape', () => {
    const source = read('src/core/target.js');
    assert.match(source, /evaluate\([\s\S]*\{ target_id \}\)/);
    assert.match(source, /ready:/);
    assert.match(source, /reasons/);
    assert.match(source, /page:/);
    assert.match(source, /chart:/);
    assert.match(source, /ohlcv:/);
    assert.match(source, /ui:/);
  });

  it('does not modify replay tooling files', () => {
    assert.doesNotMatch(read('src/core/replay.js'), /target_readiness_check/);
    assert.doesNotMatch(read('src/tools/replay.js'), /target_readiness_check/);
  });
});

describe('target readiness helper', () => {
  it('returns a ready response with telemetry when the page is ready', async () => {
    const calls = [];
    const response = await targetReadinessCheck({
      target_id: 'T1',
      expected_symbol: 'OANDA:USDCAD',
      expected_timeframe: '15',
      _deps: {
        listCdpTargets: async () => [{ id: 'T1', type: 'page', url: 'https://www.tradingview.com/chart/' }],
        evaluate: async (expression, opts) => {
          calls.push({ expression, opts });
          assert.equal(opts.target_id, 'T1');
          return {
            page: {
              href: 'https://www.tradingview.com/chart/',
              title: 'Test — OANDA:USDCAD 15',
              ready_state: 'complete',
              visibility_state: 'visible',
            },
            chart: {
              symbol: 'OANDA:USDCAD',
              resolution: '15',
              chart_type: 1,
              study_count: 7,
              studies: [
                { id: 'a', name: 'EMA 20' },
                { id: 'b', name: 'RSI 14' },
              ],
            },
            ohlcv: {
              available: true,
              first_index: 1,
              last_index: 10,
              size: 10,
              latest_bar_time: 1710000000,
            },
            ui: {
              loading_detected: false,
              modal_overlay_detected: false,
              modal_text_sample: '',
            },
          };
        },
      },
    });

    assert.equal(response.success, true);
    assert.equal(response.ready, true);
    assert.equal(response.target_id, 'T1');
    assert.equal(response.page.ready_state, 'complete');
    assert.equal(response.chart.symbol, 'OANDA:USDCAD');
    assert.equal(response.chart.resolution, '15');
    assert.equal(response.chart.study_count, 7);
    assert.equal(response.ohlcv.available, true);
    assert.equal(response.validation.expected_symbol_match, true);
    assert.equal(response.validation.expected_timeframe_match, true);
    assert.deepEqual(response.validation.reasons, []);
    assert.ok(calls.length >= 1);
  });

  it('returns ready=false with reasons when telemetry is not yet ready', async () => {
    const response = await targetReadinessCheck({
      target_id: 'T2',
      expected_symbol: 'OANDA:EURUSD',
      expected_timeframe: '60',
      max_wait_ms: 1,
      poll_interval_ms: 1,
      _deps: {
        listCdpTargets: async () => [{ id: 'T2', type: 'page', url: 'https://www.tradingview.com/chart/' }],
        evaluate: async () => ({
          page: {
            href: 'https://www.tradingview.com/chart/',
            title: 'Loading…',
            ready_state: 'interactive',
            visibility_state: 'visible',
          },
          chart: {
            symbol: '',
            resolution: '',
            chart_type: null,
            study_count: 0,
            studies: [],
          },
          ohlcv: {
            available: false,
            first_index: null,
            last_index: null,
            size: null,
            latest_bar_time: null,
          },
          ui: {
            loading_detected: true,
            modal_overlay_detected: true,
            modal_text_sample: 'Sign in required',
          },
        }),
      },
    });

    assert.equal(response.success, true);
    assert.equal(response.ready, false);
    assert.equal(response.validation.expected_symbol_match, false);
    assert.equal(response.validation.expected_timeframe_match, false);
    assert.ok(response.validation.reasons.includes('chart_symbol_missing'));
    assert.ok(response.validation.reasons.includes('chart_resolution_missing'));
    assert.ok(response.validation.reasons.includes('ohlcv_unavailable'));
    assert.ok(response.validation.reasons.includes('loading_spinner_visible'));
    assert.ok(response.validation.reasons.includes('modal_overlay_visible'));
  });
});
