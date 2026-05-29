/**
 * Unit/static tests for Chrome CDP target-locking support.
 * These tests do not require a live TradingView/CDP session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCdpConfig } from '../src/connection.js';
import { captureScreenshot } from '../src/core/capture.js';
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

  it('capture tool exposes the new readiness/retry schema fields', () => {
    const source = read('src/tools/capture.js');
    assert.match(source, /expected_symbol/);
    assert.match(source, /expected_timeframe/);
    assert.match(source, /max_attempts/);
    assert.match(source, /retry_delay_ms/);
    assert.match(source, /verify_chart_state/);
    assert.match(source, /fail_on_modal/);
  });

  it('capture core uses target_id-aware verification and returns rich metadata', () => {
    const source = read('src/core/capture.js');
    assert.match(source, /targetReadinessCheck/);
    assert.match(source, /getClient\(\{ target_id \}\)/);
    assert.match(source, /evaluate\(/);
    assert.match(source, /capture_attempts/);
    assert.match(source, /screenshot_suspicious/);
    assert.match(source, /modal_overlay_detected/);
    assert.match(source, /loading_detected/);
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

describe('capture screenshot readiness guard', () => {
  const tinyDeps = {
    listCdpTargets: async () => [{ id: 'T1', type: 'page', url: 'https://www.tradingview.com/chart/' }],
    getClient: async () => ({
      Page: {
        captureScreenshot: async () => ({ data: Buffer.alloc(4096, 7).toString('base64') }),
      },
    }),
    getChartCollection: async () => 'window.TradingViewApi._chartWidgetCollection',
    sleep: async () => {},
  };

  function cleanSample() {
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
        studies: [{ id: 'a', name: 'EMA 20' }],
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
  }

  function modalSample() {
    return {
      page: {
        href: 'https://www.tradingview.com/chart/',
        title: 'Promo',
        ready_state: 'complete',
        visibility_state: 'visible',
      },
      chart: {
        symbol: 'OANDA:USDCAD',
        resolution: '15',
        chart_type: 1,
        study_count: 7,
        studies: [{ id: 'a', name: 'EMA 20' }],
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
        modal_overlay_detected: true,
        modal_text_sample: 'Decline offer',
      },
    };
  }

  it('retries a modal-polluted capture and succeeds once the modal disappears', async () => {
    let readinessCalls = 0;
    const out = await captureScreenshot({
      target_id: 'T1',
      expected_symbol: 'OANDA:USDCAD',
      expected_timeframe: '15',
      region: 'full',
      filename: 'capture_retry_clean',
      max_attempts: 3,
      retry_delay_ms: 1,
      verify_chart_state: true,
      fail_on_modal: false,
      _deps: {
        ...tinyDeps,
        targetReadinessCheck: async () => {
          readinessCalls += 1;
          return readinessCalls === 1 ? {
            success: true,
            ready: false,
            target_id: 'T1',
            page: { href: 'https://www.tradingview.com/chart/', title: 'Promo', ready_state: 'complete', visibility_state: 'visible' },
            chart: { symbol: 'OANDA:USDCAD', resolution: '15', chart_type: 1, study_count: 7, studies: [{ id: 'a', name: 'EMA 20' }] },
            ohlcv: { available: true, first_index: 1, last_index: 10, size: 10, latest_bar_time: 1710000000 },
            ui: { loading_detected: false, modal_overlay_detected: true, modal_text_sample: 'Decline offer' },
            validation: { expected_symbol_match: true, expected_timeframe_match: true, reasons: ['modal_overlay_detected'] },
          } : {
            success: true,
            ready: true,
            target_id: 'T1',
            page: { href: 'https://www.tradingview.com/chart/', title: 'Test — OANDA:USDCAD 15', ready_state: 'complete', visibility_state: 'visible' },
            chart: { symbol: 'OANDA:USDCAD', resolution: '15', chart_type: 1, study_count: 7, studies: [{ id: 'a', name: 'EMA 20' }] },
            ohlcv: { available: true, first_index: 1, last_index: 10, size: 10, latest_bar_time: 1710000000 },
            ui: { loading_detected: false, modal_overlay_detected: false, modal_text_sample: '' },
            validation: { expected_symbol_match: true, expected_timeframe_match: true, reasons: [] },
          };
        },
      },
    });

    assert.equal(out.success, true);
    assert.equal(out.capture_attempts, 2);
    assert.equal(out.screenshot_suspicious, false);
    assert.equal(out.modal_overlay_detected, false);
    assert.equal(out.observed_symbol, 'OANDA:USDCAD');
    assert.equal(out.observed_timeframe, '15');
    assert.equal(out.verified_target_symbol, 'OANDA:USDCAD');
    assert.equal(out.verified_target_timeframe, '15');
    assert.ok(out.file_path.endsWith('capture_retry_clean.png'));
    assert.equal(out.region, 'full');
    assert.equal(out.method, 'cdp');
    assert.ok(out.size_bytes > 2048);
    assert.ok(existsSync(out.file_path));
    unlinkSync(out.file_path);
  });

  it('returns a modal guard failure when fail_on_modal is enabled', async () => {
    let captureCalls = 0;
    const out = await captureScreenshot({
      target_id: 'T1',
      expected_symbol: 'OANDA:USDCAD',
      expected_timeframe: '15',
      region: 'full',
      filename: 'capture_modal_blocked',
      max_attempts: 3,
      retry_delay_ms: 1,
      verify_chart_state: true,
      fail_on_modal: true,
      _deps: {
        ...tinyDeps,
        evaluate: async () => modalSample(),
        getClient: async () => ({
          Page: {
            captureScreenshot: async () => {
              captureCalls += 1;
              return { data: Buffer.alloc(4096, 7).toString('base64') };
            },
          },
        }),
      },
    });

    assert.equal(out.success, false);
    assert.equal(out.retry_reason, 'modal_overlay_detected');
    assert.equal(out.modal_overlay_detected, true);
    assert.equal(out.modal_text_sample, 'Decline offer');
    assert.equal(out.capture_attempts, 1);
    assert.equal(captureCalls, 0);
    assert.ok(!out.file_path || !existsSync(out.file_path));
  });

  it('treats method=api as trigger-only and returns success without a local file', async () => {
    let takeScreenshotCalls = 0;
    let chartCollectionRequested = false;
    const out = await captureScreenshot({
      target_id: 'T1',
      expected_symbol: 'OANDA:USDCAD',
      expected_timeframe: '15',
      region: 'chart',
      method: 'api',
      max_attempts: 3,
      retry_delay_ms: 1,
      verify_chart_state: true,
      fail_on_modal: false,
      _deps: {
        ...tinyDeps,
        getChartCollection: async ({ target_id }) => {
          chartCollectionRequested = target_id === 'T1';
          return 'window.TradingViewApi._chartWidgetCollection';
        },
        evaluate: async (expression) => {
          if (String(expression).includes('takeScreenshot')) {
            takeScreenshotCalls += 1;
            return undefined;
          }
          return cleanSample();
        },
      },
    });

    assert.equal(out.success, true);
    assert.equal(out.method, 'api');
    assert.equal(out.note, 'takeScreenshot() triggered — TradingView handles save/show via its own UI');
    assert.equal(out.capture_attempts, 1);
    assert.equal(out.screenshot_suspicious, false);
    assert.equal(out.reason, null);
    assert.equal(out.file_path, undefined);
    assert.equal(out.size_bytes, undefined);
    assert.equal(out.chart_bounds_available, undefined);
    assert.equal(out.retry_reason, undefined);
    assert.equal(out.modal_overlay_detected, false);
    assert.equal(out.loading_detected, false);
    assert.equal(out.observed_symbol, 'OANDA:USDCAD');
    assert.equal(out.observed_timeframe, '15');
    assert.equal(chartCollectionRequested, true);
    assert.equal(takeScreenshotCalls, 1);
  });

  it('keeps method=api successful even when chart bounds are unavailable', async () => {
    let takeScreenshotCalls = 0;
    const out = await captureScreenshot({
      target_id: 'T1',
      expected_symbol: 'OANDA:USDCAD',
      expected_timeframe: '15',
      region: 'chart',
      method: 'api',
      max_attempts: 1,
      retry_delay_ms: 1,
      verify_chart_state: true,
      fail_on_modal: false,
      _deps: {
        ...tinyDeps,
        evaluate: async (expression) => {
          if (String(expression).includes('takeScreenshot')) {
            takeScreenshotCalls += 1;
            return undefined;
          }
          return cleanSample();
        },
      },
    });

    assert.equal(out.success, true);
    assert.equal(out.screenshot_suspicious, false);
    assert.equal(out.region, 'chart');
    assert.equal(out.chart_bounds_available, undefined);
    assert.equal(out.retry_reason, undefined);
    assert.equal(out.file_path, undefined);
    assert.equal(out.size_bytes, undefined);
    assert.equal(takeScreenshotCalls, 1);
  });

  it('returns a modal guard failure for method=api when fail_on_modal is enabled', async () => {
    let takeScreenshotCalls = 0;
    const out = await captureScreenshot({
      target_id: 'T1',
      expected_symbol: 'OANDA:USDCAD',
      expected_timeframe: '15',
      method: 'api',
      max_attempts: 1,
      retry_delay_ms: 1,
      verify_chart_state: true,
      fail_on_modal: true,
      _deps: {
        ...tinyDeps,
        targetReadinessCheck: async () => ({
          success: true,
          ready: true,
          target_id: 'T1',
          page: { href: 'https://www.tradingview.com/chart/', title: 'Promo', ready_state: 'complete', visibility_state: 'visible' },
          chart: { symbol: 'OANDA:USDCAD', resolution: '15', chart_type: 1, study_count: 7, studies: [{ id: 'a', name: 'EMA 20' }] },
          ohlcv: { available: true, first_index: 1, last_index: 10, size: 10, latest_bar_time: 1710000000 },
          ui: { loading_detected: false, modal_overlay_detected: true, modal_text_sample: 'Decline offer' },
          validation: { expected_symbol_match: true, expected_timeframe_match: true, reasons: ['modal_overlay_detected'] },
        }),
        evaluate: async (expression) => {
          if (String(expression).includes('takeScreenshot')) {
            takeScreenshotCalls += 1;
          }
          return undefined;
        },
      },
    });

    assert.equal(out.success, false);
    assert.equal(out.reason, 'modal_overlay_detected');
    assert.equal(out.retry_reason, 'modal_overlay_detected');
    assert.equal(out.modal_overlay_detected, true);
    assert.equal(out.modal_text_sample, 'Decline offer');
    assert.equal(out.capture_attempts, 1);
    assert.equal(takeScreenshotCalls, 0);
    assert.ok(!out.file_path || !existsSync(out.file_path));
  });

  it('marks chart-region captures suspicious when chart bounds are unavailable', async () => {
    const out = await captureScreenshot({
      target_id: 'T1',
      expected_symbol: 'OANDA:USDCAD',
      expected_timeframe: '15',
      region: 'chart',
      filename: 'capture_bounds_missing',
      max_attempts: 1,
      retry_delay_ms: 1,
      verify_chart_state: true,
      fail_on_modal: false,
      _deps: {
        ...tinyDeps,
        evaluate: async (expression) => {
          if (String(expression).includes('pane-canvas') || String(expression).includes('chart-container') || String(expression).includes("querySelector('canvas')")) {
            return null;
          }
          return cleanSample();
        },
      },
    });

    assert.equal(out.success, false);
    assert.equal(out.screenshot_suspicious, true);
    assert.equal(out.retry_reason, 'chart_bounds_unavailable');
    assert.equal(out.capture_attempts, 1);
    assert.equal(out.region, 'chart');
    assert.ok(existsSync(out.file_path));
    unlinkSync(out.file_path);
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
