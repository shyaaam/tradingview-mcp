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
    assert.match(expressions[0], /linkingGroupIndex\(\)/u);
    assert.match(expressions[0], /groups\.forEach\(function\(group, paneIndex\)/u);
    assert.match(expressions[0], /group\.property\.setValue\(isolationGroup \+ paneIndex\)/u);
    assert.match(expressions[0], /symbolWatchers\.forEach\(function\(entry\)/u);
    assert.match(expressions[0], /entry\.watcher\._listeners = \[\]/u);
    assert.match(expressions[0], /entry\.watcher\._listeners = entry\.listeners/u);
    assert.match(expressions[0], /series\.setSymbolParams\(\{ symbol:/u);
    assert.match(expressions[0], /group\.property\.setValue\(group\.value\)/u);
    assert.match(expressions[0], /mainSeries\(\)/u);
    assert.doesNotMatch(expressions[0], /model\.setSymbol\(/u);
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
