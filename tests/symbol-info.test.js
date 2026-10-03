import assert from 'node:assert/strict';
import test from 'node:test';

import { symbolInfo } from '../src/core/chart.js';

test('symbol_info reads current TradingView symbolExt metadata through bound evaluator', async () => {
  let expression = '';
  const metadata = {
    symbol: 'BTCUSDT',
    full_name: 'Bybit:BTCUSDT',
    exchange: 'Bybit',
    description: 'BTCUSDT SPOT',
    type: 'crypto',
    pro_name: 'BYBIT:BTCUSDT',
    typespecs: ['crypto'],
    resolution: '1',
    chart_type: 1,
  };

  const result = await symbolInfo({
    _deps: {
      evaluate: async (script) => {
        expression = script;
        return metadata;
      },
    },
  });

  assert.match(expression, /symbolExt\(\)/u);
  assert.deepEqual(result, { success: true, ...metadata });
});
