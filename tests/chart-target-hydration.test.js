import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeChartUrl } from '../src/core/chart-target-hydration.js';

const origins = ['https://www.tradingview.com'];

test('normalizes exact authorized saved-chart URL', () => {
  assert.equal(normalizeChartUrl('https://www.tradingview.com/chart/AbCd12', origins, 'AbCd12'), 'https://www.tradingview.com/chart/AbCd12/');
});

test('rejects unsupported origin', () => {
  assert.throws(() => normalizeChartUrl('https://evil.example/chart/AbCd12/', origins, 'AbCd12'), /origin is not authorized/);
});

test('rejects saved-chart mismatch and broad paths', () => {
  assert.throws(() => normalizeChartUrl('https://www.tradingview.com/chart/Other/', origins, 'AbCd12'), /does not match/);
  assert.throws(() => normalizeChartUrl('https://www.tradingview.com/markets/', origins, 'AbCd12'), /does not match/);
});

test('rejects credentials and fragments', () => {
  assert.throws(() => normalizeChartUrl('https://user@www.tradingview.com/chart/AbCd12/', origins, 'AbCd12'), /without credentials/);
  assert.throws(() => normalizeChartUrl('https://www.tradingview.com/chart/AbCd12/#x', origins, 'AbCd12'), /without credentials/);
});
