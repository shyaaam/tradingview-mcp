import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setSymbol } from '../src/core/pane.js';

describe('pane_set_symbol scoped mutation', () => {
  it('uses explicit target chart list and checks sibling stability', async () => {
    const expressions = [];
    const result = await setSymbol({
      index: 2,
      symbol: 'BTCUSDT',
      _deps: {
        focus: async () => undefined,
        evaluateAsync: async (expression) => {
          expressions.push(expression);
          return { success: true, symbol: 'BITSTAMP:BTCUSDT' };
        },
      },
    });

    assert.deepEqual(result, { success: true, index: 2, symbol: 'BTCUSDT' });
    assert.equal(expressions.length, 1);
    assert.match(expressions[0], /model\.setSymbol\(series/u);
    assert.match(expressions[0], /mainSeries\(\)/u);
    assert.doesNotMatch(expressions[0], /_setSymbolImpl\(/u);
    assert.doesNotMatch(expressions[0], /symbolLock\._value/u);
    assert.match(expressions[0], /siblingDrift/u);
    assert.doesNotMatch(expressions[0], /chart\.setSymbol\(/u);
  });

  it('rejects invalid pane indexes before browser evaluation', async () => {
    await assert.rejects(
      () => setSymbol({ index: -1, symbol: 'BTCUSDT' }),
      /Pane index must be a non-negative integer/u,
    );
  });
});
