import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { waitForChartReady } from '../src/wait.js';

function browserEvaluator(canonicalSymbol, selectors, canonicalResolution = '1') {
  return (expression) => runInNewContext(expression, {
    window: {
      TradingViewApi: {
        _activeChartWidgetWV: {
          value: () => ({
            symbol: () => canonicalSymbol,
            resolution: () => canonicalResolution,
          }),
        },
      },
    },
    document: {
      querySelector: (selector) => {
        selectors.push(selector);
        if (selector.includes('legend-source-title') || selector.includes('apply-common-tooltip')) {
          return { textContent: 'EBritish Pound / U.S. Dollar' };
        }
        return null;
      },
      querySelectorAll: () => ({ length: 48 }),
    },
  });
}

test('readiness uses canonical pane symbol when TradingView legend shows display name', async () => {
  const selectors = [];
  const expectedSymbol = 'OANDA:GBPUSD';
  let reads = 0;

  const ready = await waitForChartReady(expectedSymbol, null, 5_000, {
    evaluate: async (expression) => {
      reads += 1;
      return browserEvaluator(expectedSymbol, selectors)(expression);
    },
  });

  assert.equal(ready, true);
  assert.equal(reads, 3);
  assert.equal(selectors.some((selector) => selector.includes('legend-source-title')
    || selector.includes('apply-common-tooltip')), false);
});

test('readiness stays false when canonical pane symbol is unavailable, mismatched, or only partially matches', async () => {
  for (const currentSymbol of ['OANDA:EURUSD', '', 'NOTOANDA:GBPUSD']) {
    let reads = 0;
    const selectors = [];
    const ready = await waitForChartReady('OANDA:GBPUSD', null, 1, {
      evaluate: async (expression) => {
        reads += 1;
        return browserEvaluator(currentSymbol, selectors)(expression);
      },
    });

    assert.equal(ready, false);
    assert.equal(reads, 1);
  }
});

test('readiness stays false until canonical pane resolution exactly matches expected timeframe', async () => {
  for (const currentResolution of ['', '1D', '1480']) {
    let reads = 0;
    const ready = await waitForChartReady('OANDA:USDJPY', '480', 1, {
      evaluate: async (expression) => {
        reads += 1;
        return browserEvaluator('OANDA:USDJPY', [], currentResolution)(expression);
      },
    });

    assert.equal(ready, false);
    assert.equal(reads, 1);
  }
});

test('readiness becomes true after canonical pane symbol and resolution match with stable bars', async () => {
  let reads = 0;
  const ready = await waitForChartReady('OANDA:USDJPY', '480', 5_000, {
    evaluate: async (expression) => {
      reads += 1;
      return browserEvaluator('OANDA:USDJPY', [], '480')(expression);
    },
  });

  assert.equal(ready, true);
  assert.equal(reads, 3);
});
